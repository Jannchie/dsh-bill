/**
 * Lazy-tool judgement for dsh-bill's `bill_stats` tool.
 *
 * `bill_stats` is registered unconditionally (execution semantics are never
 * touched), but its ~2.2k-token schema rides on every model request. When a
 * positive lookback window is set, this module decides, from the same derived
 * message history the model is about to receive, whether the request looks
 * like a cost question — and the `system-prompt/assemble` listener in
 * index.js hides the tool when it does not. A window of 0 hides it from
 * every request.
 *
 * Pure and dependency-free so it can be unit-tested offline.
 * @module dsh-bill/lazy
 */

/**
 * The built-in cost-question pattern, shipped as the default for the
 * `lazyToolsPattern` preference. Lives here — beside the matcher — so the
 * unit tests import the same source production uses and the two cannot drift
 * (a prior hand-maintained test copy had a double-escaped `\\s` that silently
 * differed from this one). Case-insensitive; `token\s*消耗` matches
 * "token 消耗" and "token消耗".
 */
export const DEFAULT_LAZY_PATTERN = '费用|花费|成本|账单|花了|多少钱|用量|消耗|支出|开销|token\\s*消耗|cost|spend|spent|paid|bill|usage|tokens|price|fee|charge|how much|bill_stats'


/**
 * Whether text matches a pre-compiled pattern. Module-private: the single
 * matching implementation, shared by the matcher from createLazyMatcher, so
 * the two cannot drift.
 *
 * The hot path: the caller owns the RegExp cache, so the per-request cost is
 * one `.test()`. A null/absent pattern is "always relevant" — the tool stays
 * visible until the user writes one.
 * @param {string} text
 * @param {RegExp | null} re - compiled case-insensitive pattern, or null.
 * @returns {boolean} true when the tool should stay visible.
 */
function patternMatches(text, re) {
  if (!re) return true
  try {
    return re.test(String(text ?? ''))
  } catch {
    return true
  }
}

/**
 * Build a per-source matcher for the assemble listener's hot path.
 *
 * The returned function takes `(text, pattern)`; it recompiles only when the
 * pattern source changes (a settings edit is live for the very next request),
 * and a stable source costs one `.test()` per call. Compilation lives here,
 * beside the single matching implementation, so index.js stays a pure
 * consumer of the judgement.
 * @returns {(text: string, pattern: string) => boolean}
 */
export function createLazyMatcher() {
  let source = null
  let re = null
  return function matchLazy(text, pattern) {
    const next = typeof pattern === 'string' ? pattern : ''
    if (source !== next) {
      source = next
      try { re = next ? new RegExp(next, 'i') : null } catch { re = null }
    }
    return patternMatches(text, re)
  }
}

/**
 * Assemble one plain string from the text blocks of the recent messages.
 * Accepts the frozen `Message[]` shape `session.deriveMessages()` returns.
 *
 * Only messages that actually carry text consume a lookback slot. A user-role
 * entry with no text block — a tool result, an image-only attachment — is
 * skipped without counting, so the trailing tool results of a working turn
 * cannot push the user's own question out of the window before a follow-up
 * request ("and last week?").
 * @param {Array<{content?: unknown}>} messages - derived messages, newest last.
 * @param {number} lookback - how many text-bearing trailing messages to scan (>= 1).
 */
export function recentText(messages, lookback) {
  if (!Array.isArray(messages)) return ''
  const n = Math.max(1, Math.floor(lookback) || 1)
  // Walk newest first and count only text-bearing messages toward the window.
  const parts = []
  let taken = 0
  for (let i = messages.length - 1; i >= 0 && taken < n; i--) {
    const content = messages[i]?.content
    if (!content) continue
    const texts = []
    for (const block of Array.isArray(content) ? content : [content]) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
    if (texts.length === 0) continue
    taken++
    parts.unshift(texts.join('\n'))
  }
  return parts.join('\n')
}
