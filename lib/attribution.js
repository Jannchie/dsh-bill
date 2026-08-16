/**
 * Cost attribution for dsh-bill.
 *
 * The dashboard's other views answer "how much" — this one answers "on what".
 * A request's bill is split across the KINDS OF CONTENT that occupied its
 * context: tool output read in, the model's own past text, the system prompt,
 * terminal commands, what you actually typed.
 *
 * Three things make the split defensible rather than decorative:
 *
 *   - **It is a carry-forward bill, not a usage bill.** Every request pays for
 *     its whole context again, so a tool result read once keeps billing on
 *     every later request until it falls out of the window. Attributing per
 *     request and summing is what surfaces that.
 *   - **Position decides the rate, not an average.** Prefix caching means the
 *     first N prompt tokens are cache hits and the rest are fresh — and those
 *     rates differ by up to 156× on DeepSeek. Segments are walked in the exact
 *     order the provider sees them, so the cached prefix is charged at the
 *     cache rate and only the tail pays full price. Splitting a request's cost
 *     by a flat per-token average would move real money to the wrong rows.
 *   - **Only counts are kept.** Attribution runs at capture time against the
 *     live request; what is persisted is character counts and dollars per
 *     category, never prompt text.
 *
 * Token counts per segment are estimated from character share (the provider
 * reports one total, not a per-block breakdown), but the TOTAL is the real
 * billed number, so the columns always add up to the bill actually paid.
 *
 * @module dsh-bill/attribution
 */

/**
 * Top-level bucket ids, in display order.
 *
 * Ids only: display text and colour belong to the browser half, which owns
 * presentation and can localize. These strings are also persisted inside every
 * record's attribution key, so they are a storage format — renaming one
 * silently splits a category's history in two.
 */
export const CATEGORIES = ['tool-read', 'model', 'system', 'terminal', 'tool-write', 'media', 'scaffold', 'user']

/**
 * Detail ids for the fixed sub-buckets. Tool names and shell programs are used
 * verbatim as detail ids instead — they are already the identifier the user
 * knows them by, and the set is open-ended.
 */
export const DETAILS = {
  systemPrompt: 'prompt.system',
  toolSchema: 'prompt.tools',
  replyCarried: 'model.reply.carried',
  thinkingCarried: 'model.thinking.carried',
  toolArgs: 'model.tool-args',
  reply: 'model.reply',
  thinking: 'model.thinking',
  typed: 'user.typed',
  reminder: 'scaffold.reminder',
  attachment: 'media.attachment',
  unknownTool: 'tool.unknown',
}

/**
 * Tools whose ARGUMENTS are the payload — the model is writing content out
 * through them. Their results are a receipt ("ok, 3 lines changed"), so the
 * cost belongs to the call, not the reply.
 */
const WRITE_TOOLS = new Set([
  'write', 'edit', 'str_replace_editor', 'todo_write', 'create_goal', 'update_goal',
])

/**
 * Tools that run a shell command. Their spend is grouped by the PROGRAM
 * invoked rather than by the tool, because "终端命令 $4.15" says nothing while
 * "git $2.18" says stop pasting whole diffs.
 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent'])

/** Reminder/scaffold text the harness injects into user turns. */
const SCAFFOLD_PATTERNS = [/^<system-reminder>/, /^<command-name>/, /^<local-command/, /^<task-notification>/]

/**
 * Tool schemas are large, identical across the calls of a session, and
 * measured on the request path — so their length is memoised by reference
 * rather than re-serialising tens of kilobytes of JSON per call.
 */
let lastTools = null
let lastToolsChars = 0
function toolsChars(tools) {
  if (!tools) return 0
  if (tools === lastTools) return lastToolsChars
  lastTools = tools
  lastToolsChars = charsOf(tools)
  return lastToolsChars
}

/** Length of a value as it reaches the model (JSON for structured payloads). */
function charsOf(value) {
  if (typeof value === 'string') return value.length
  if (value === null || value === undefined) return 0
  try { return JSON.stringify(value).length } catch { return 0 }
}

/** Total text length inside a (possibly nested) content block list. */
function blockChars(blocks) {
  let total = 0
  for (const block of blocks ?? []) {
    if (!block) continue
    if (typeof block.text === 'string') total += block.text.length
    if (Array.isArray(block.content)) total += blockChars(block.content)
  }
  return total
}

/**
 * The program a shell tool call runs: `git`, `pnpm`, `rg`.
 *
 * Reads the first bare word, skipping `sudo` and `VAR=value` prefixes. A
 * command that cannot be parsed is grouped under the tool name rather than
 * guessed at.
 */
export function shellProgram(argumentsJson) {
  let command
  try {
    const parsed = JSON.parse(argumentsJson)
    command = parsed?.command ?? parsed?.cmd ?? parsed?.script
  } catch { /* not JSON — fall through */ }
  if (typeof command !== 'string') return null
  for (const word of command.trim().split(/\s+/)) {
    if (word === 'sudo' || /^[A-Z_][A-Z0-9_]*=/.test(word)) continue
    const program = word.replace(/^.*\//, '')
    return program || null
  }
  return null
}

/** Whether a user-side text block is harness scaffolding rather than typing. */
function isScaffold(text) {
  const head = text.slice(0, 64)
  return SCAFFOLD_PATTERNS.some((re) => re.test(head))
}

/**
 * Split one request into ordered, categorized segments.
 *
 * Order is the order the provider sees — system, tool schemas, then messages —
 * which is what makes the cached-prefix walk in `attributeCost` correct.
 *
 * @param options - the `llm/stream` GenerateOptions (messages, system, tools).
 * @returns [{ cat, sub, chars }] with zero-length segments dropped.
 */
export function segmentsOf(options) {
  const segments = []
  const push = (cat, sub, chars) => { if (chars > 0) segments.push({ cat, sub, chars }) }

  push('system', DETAILS.systemPrompt, charsOf(options?.system))
  push('system', DETAILS.toolSchema, toolsChars(options?.tools))

  // toolCallId → what the call was, so a result can be attributed to the tool
  // that produced it. Built as we walk, since a call always precedes its result.
  const callInfo = new Map()

  for (const message of options?.messages ?? []) {
    const role = message?.role
    for (const block of message?.content ?? []) {
      if (!block) continue
      switch (block.type) {
        case 'text': {
          const text = block.text ?? ''
          if (role === 'assistant') push('model', DETAILS.replyCarried, text.length)
          else if (isScaffold(text)) push('scaffold', DETAILS.reminder, text.length)
          else push('user', DETAILS.typed, text.length)
          break
        }
        case 'reasoning':
          push('model', DETAILS.thinkingCarried, (block.text ?? '').length)
          break
        case 'image':
          push('media', DETAILS.attachment, charsOf(block.attachment))
          break
        case 'tool-call': {
          const name = block.name ?? 'unknown'
          const chars = (block.arguments ?? '').length
          if (SHELL_TOOLS.has(name)) {
            const program = shellProgram(block.arguments)
            callInfo.set(block.id, { cat: 'terminal', sub: program ?? name })
            push('terminal', program ?? name, chars)
          } else if (WRITE_TOOLS.has(name)) {
            callInfo.set(block.id, { cat: 'tool-write', sub: name })
            push('tool-write', name, chars)
          } else {
            callInfo.set(block.id, { cat: 'tool-read', sub: name })
            push('model', DETAILS.toolArgs, chars)
          }
          break
        }
        case 'tool-result': {
          const info = callInfo.get(block.toolCallId)
          const chars = blockChars(block.content)
          // A write tool's result is a receipt, not content: bill it to the
          // tool so the row stays "what Edit cost me", not a second bucket.
          if (info) push(info.cat, info.sub, chars)
          else push('tool-read', DETAILS.unknownTool, chars)
          break
        }
        default:
          // Merge-extensible block vocabulary: an unknown block still occupies
          // context, so it is counted rather than dropped.
          push('scaffold', DETAILS.reminder, charsOf(block))
      }
    }
  }
  return segments
}

/**
 * Attribute one request's billed cost across its segments.
 *
 * @param segments - from `segmentsOf`, in provider order.
 * @param usage - DSH's disjoint counts { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }.
 * @param outputChars - { text, reasoning } observed on the response stream.
 * @param rates - per-token rate card (llm-pricing ModelPrice).
 * @returns { 'cat|sub': usd } — sums to the request's billed cost.
 */
export function attributeCost(segments, usage, outputChars, rates) {
  const out = {}
  const add = (cat, sub, usd) => {
    if (!(usd > 0)) return
    const key = cat + '|' + sub
    out[key] = (out[key] ?? 0) + usd
  }

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const fresh = usage.inputTokens ?? 0
  const promptTokens = fresh + cacheRead + cacheWrite
  const totalChars = segments.reduce((sum, s) => sum + s.chars, 0)

  if (promptTokens > 0 && totalChars > 0) {
    // Walk the prompt in order and spend the cached prefix first: the first
    // `cacheRead` tokens hit the cache, the next `cacheWrite` were written to
    // it, and only the tail pays the fresh input rate. This is what prefix
    // caching actually bills, and the rates differ enough (156x on DeepSeek)
    // that a flat average would be a different report.
    let consumed = 0
    for (const segment of segments) {
      const tokens = segment.chars / totalChars * promptTokens
      let remaining = tokens
      let cursor = consumed
      // How much of this segment falls in each of the three price zones.
      const zones = [
        [0, cacheRead, rates.cacheReadInputCostPerToken],
        [cacheRead, cacheRead + cacheWrite, rates.cacheCreationInputCostPerToken],
        [cacheRead + cacheWrite, Number.POSITIVE_INFINITY, rates.inputCostPerToken],
      ]
      for (const [start, end, rate] of zones) {
        if (remaining <= 0) break
        const overlap = Math.max(0, Math.min(cursor + remaining, end) - Math.max(cursor, start))
        if (overlap > 0) {
          add(segment.cat, segment.sub, overlap * rate)
          remaining -= overlap
          cursor += overlap
        }
      }
      consumed += tokens
    }
  }

  // Output side: the model's own generation, split into visible text vs
  // thinking by what actually came back on the stream.
  const outputTokens = usage.outputTokens ?? 0
  if (outputTokens > 0) {
    const textChars = outputChars?.text ?? 0
    const reasoningChars = outputChars?.reasoning ?? 0
    const totalOut = textChars + reasoningChars
    const outputUsd = outputTokens * rates.outputCostPerToken
    if (totalOut > 0) {
      add('model', DETAILS.reply, outputUsd * textChars / totalOut)
      add('model', DETAILS.thinking, outputUsd * reasoningChars / totalOut)
    } else {
      add('model', DETAILS.reply, outputUsd)
    }
  }

  return out
}

/**
 * Scale an attribution map so it sums exactly to the record's billed cost.
 *
 * The zone walk and llm-pricing compute the same arithmetic by different
 * routes, so they agree to within float noise — but "the columns add up to the
 * bill" is the property that makes the report trustworthy, so it is enforced
 * rather than assumed.
 */
export function normalizeTo(attribution, billedUsd) {
  const sum = Object.values(attribution).reduce((a, b) => a + b, 0)
  if (!(sum > 0) || !(billedUsd > 0)) return attribution
  const factor = billedUsd / sum
  if (Math.abs(factor - 1) < 1e-9) return attribution
  const scaled = {}
  for (const [key, value] of Object.entries(attribution)) scaled[key] = value * factor
  return scaled
}
