/**
 * The `billTurns` session projection: what each turn of one conversation cost.
 *
 * This is the second, independent source of truth in dsh-bill, and it exists
 * because the first one cannot answer per-turn questions. The `llm/stream`
 * capture path sees request CONTENT — which is why attribution lives there and
 * can live nowhere else — but it sees no turn boundaries at all:
 * `GenerateOptions` carries `sessionId` and nothing about the turn or step the
 * loop is running. The durable session log carries the opposite pair: every
 * `turn/start` / `step/end` boundary and the provider's own usage report, and
 * no request body whatsoever.
 *
 * So the split is not duplication, it is the only decomposition available:
 *
 *   - `llm/stream` → global spend, and the content attribution (what the money
 *     was spent ON), for calls made while the plugin was installed.
 *   - this projection → per-session and per-turn spend (WHERE the money went),
 *     for the entire durable log, including everything that predates the
 *     install.
 *
 * Registering it as a projection unit rather than folding the log ourselves
 * buys three things the plugin would otherwise have to build: the framework
 * drives `apply` over every committed event, caches the state per session with
 * a persisted checkpoint keyed on `stateVersion`, and PUSHES the new value to
 * every mounted client. The browser half reads it through `useProjection` and
 * holds no folding code and no polling timer.
 *
 * Contract notes that shape the code below:
 *   - `apply` must be synchronous, pure, and return the SAME state reference
 *     when the event is not ours — an unchanged reference is the framework's
 *     signal to do zero downstream work, and it is what keeps this unit free
 *     on the ~95% of events (chunks, tool calls) that carry no usage.
 *   - `state` must be plain JSON, because it is what gets checkpointed.
 *   - `stateVersion` must be bumped whenever the state shape or the fold
 *     semantics change, or stale rows are forward-applied into garbage.
 *
 * @module dsh-bill/projection
 */

import { cacheWrite1hOf, priceRecord, pricingEpoch, roundCost } from './pricing.js'

/** Projection key. Also the string the browser half passes to `useProjection`. */
export const BILL_TURNS_KEY = 'billTurns'

/**
 * Bump on any change to the state shape or the fold. The framework discards
 * persisted rows stamped with a different version instead of resuming from
 * them, so a forgotten bump is a silently corrupt cost history.
 */
// 2: rows and totals carry `cacheWrite1hTokens`, the one-hour share of the
//    cache writes, so a long-cache route is priced at its own write rate.
const STATE_VERSION = 2

/**
 * How many turns keep their own row.
 *
 * The totals are unbounded and exact; only the per-turn detail is capped, and
 * only because the state is checkpointed per session — an unbounded row list
 * would grow the persisted cache without limit on a long-running conversation.
 * The oldest rows are dropped, not folded away, because their cost is already
 * inside the totals: a dropped row costs the reader a cost line on a turn
 * scrolled far out of view, never a wrong total.
 */
const MAX_TURN_ROWS = 400

/** Empty per-turn accumulator. */
const emptyTurn = (turn, time) => ({
  turn,
  time,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  model: null,
  provider: null,
})

/** Initial state: no header seen, no turns folded. */
function init() {
  return {
    /** Route from the newest `request/header`; the fallback for a usage sample. */
    model: null,
    provider: null,
    /** Per-turn rows in turn order, capped at {@link MAX_TURN_ROWS}. */
    turns: [],
    /** Every turn's tokens, including the rows that have aged out. */
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 },
    /**
     * The newest usage sample: `{ turn, step, tokens }`.
     *
     * One step reports usage twice — once as a streaming `assistant/chunk`,
     * once on the finalized `assistant/message` — and a retried step reports
     * again. Adding both would double the bill. A repeated sample for the same
     * `turn:step` therefore REPLACES its predecessor: the earlier tokens are
     * subtracted before the new ones go in.
     *
     * One slot is enough because the session log guarantees that a step's
     * usage reports are adjacent — once a later step opens, a legal log never
     * reports usage for an earlier one again. (This is the same invariant
     * dsh-token-meter's own usage projection relies on.)
     */
    last: null,
  }
}

/**
 * Add (or, with `sign` -1, subtract) the token buckets into `target`.
 *
 * Mutates, and every caller passes a local it has just copied — the state
 * reachable from `state` is never touched, so `apply` stays pure. Written this
 * way because the value form forced `{ ...row, ...addTokens(row, …) }` at each
 * of five call sites: six object allocations per usage event, and an idiom
 * that reads as "merge a computed patch" for what is four additions.
 */
function addTokens(target, tokens, sign) {
  target.inputTokens += sign * tokens.inputTokens
  target.outputTokens += sign * tokens.outputTokens
  target.cacheReadTokens += sign * tokens.cacheReadTokens
  target.cacheWriteTokens += sign * tokens.cacheWriteTokens
  target.cacheWrite1hTokens += sign * tokens.cacheWrite1hTokens
  return target
}

/** Usage carried by an event, or undefined when it carries none. */
function usageOf(event) {
  if (event.type === 'assistant/message') return event.data?.usage
  if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
    return event.data.chunk.usage
  }
  return undefined
}

/**
 * Pure transition. Returns `state` itself for every event that is not a route
 * change or a usage report — which is nearly all of them.
 */
function apply(state, event) {
  if (!event || typeof event !== 'object') return state

  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    const model = typeof config?.model === 'string' && config.model ? config.model : null
    const provider = typeof config?.provider === 'string' && config.provider ? config.provider : null
    if (model === null && provider === null) return state
    if (model === state.model && provider === state.provider) return state
    return { ...state, model: model ?? state.model, provider: provider ?? state.provider }
  }

  const usage = usageOf(event)
  if (!usage) return state

  const turn = Number.isFinite(event.data?.turn) ? event.data.turn : -1
  const step = Number.isFinite(event.data?.step) ? event.data.step : -1
  const tokens = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: cacheWrite1hOf(usage),
  }
  // A repeat of the newest sample corrects it rather than adding to it.
  const repeat = state.last !== null && state.last.turn === turn && state.last.step === step
  const previous = repeat ? state.last.tokens : null

  // A finalized message names the exact route that produced it; a bare usage
  // chunk does not, and falls back to the header in force.
  const source = event.data?.message?.source
  const model = typeof source?.model === 'string' && source.model ? source.model : state.model
  const provider = typeof source?.provider === 'string' && source.provider ? source.provider : state.provider

  const turns = state.turns.slice()
  let index = turns.length - 1
  while (index >= 0 && turns[index].turn !== turn) index--
  const time = typeof event.time === 'number' ? event.time : 0
  // Fresh copies on both branches, so the adds below mutate nothing the old
  // state can still see.
  const row = index >= 0 ? { ...turns[index] } : emptyTurn(turn, time)
  const totals = { ...state.totals }
  if (previous) {
    addTokens(row, previous, -1)
    addTokens(totals, previous, -1)
  } else {
    row.calls += 1
    totals.calls += 1
  }
  addTokens(row, tokens, 1)
  addTokens(totals, tokens, 1)
  if (model) row.model = model
  if (provider) row.provider = provider
  if (index >= 0) turns[index] = row
  else turns.push(row)

  // Drop the oldest rows once the cap is passed; their tokens stay in `totals`.
  const overflow = turns.length - MAX_TURN_ROWS
  if (overflow > 0) turns.splice(0, overflow)

  return { ...state, turns, totals, last: { turn, step, tokens } }
}

/**
 * Price a token bucket at the timestamp it was billed at.
 *
 * Pricing lives here, in `view`, rather than in `apply`, for two reasons: the
 * catalogue is loaded asynchronously and would make `apply` impure, and a
 * price correction (a fresh catalogue fetch, an added `priceOverrides` entry)
 * must be able to reach turns that were folded before it arrived. `view` runs
 * on every read, so it always prices against the catalogue as it stands now.
 *
 * The cost is `null`, never 0, for a model no catalogue lists — the browser
 * renders that as "unpriced", which is the honest answer.
 */
function priced(bucket) {
  const result = priceRecord({
    model: bucket.model ?? 'unknown',
    time: bucket.time,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    cacheWrite1hTokens: bucket.cacheWrite1hTokens,
  })
  return { usd: result.usd, peak: result.peak, displayName: result.displayName }
}

/**
 * Wire rows already built, keyed by the state row they were built from.
 *
 * `view` runs on every read AND every state change, while `apply` replaces
 * exactly ONE row per usage event and carries the rest across by reference —
 * so without a cache, a 400-turn session reprices 400 rows (three catalogue
 * lookups each) to reflect a change to one of them, twice per step. Keying on
 * row identity turns that into one repricing per event.
 *
 * A WeakMap holds no reference of its own, so rows die with the state that
 * held them. `pricingEpoch` from the catalogue invalidates everything when the
 * rates themselves move — the reason pricing lives in `view` at all.
 */
let priceCache = new WeakMap()
let priceCacheEpoch = -1

/** The wire row for one state row, priced at most once per catalogue epoch. */
function wireRow(row) {
  const epoch = pricingEpoch()
  if (epoch !== priceCacheEpoch) {
    priceCache = new WeakMap()
    priceCacheEpoch = epoch
  }
  const hit = priceCache.get(row)
  if (hit !== undefined) return hit
  const cost = priced(row)
  const built = {
    turn: row.turn,
    time: row.time,
    calls: row.calls,
    model: row.model,
    provider: row.provider,
    displayName: cost.displayName ?? null,
    peak: cost.peak,
    usd: cost.usd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
  }
  priceCache.set(row, built)
  return built
}

/** State → the whole value the browser reads. */
function view(state) {
  // The session total is the sum of its turns rather than one call priced on
  // the aggregate: the rate card is time-dependent (DeepSeek's peak windows),
  // so a session spanning a window boundary must be priced turn by turn.
  // `held` accumulates in the same pass — it is the same four buckets over the
  // same rows, and splitting it out only invited the two loops to drift.
  const turns = []
  const held = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }
  let totalUsd = 0
  let allPriced = state.turns.length > 0
  for (const source of state.turns) {
    const row = wireRow(source)
    turns.push(row)
    if (row.usd === null) allPriced = false
    else totalUsd += row.usd
    held.calls += row.calls
    addTokens(held, row, 1)
  }
  // Turns that aged out of the row list are still in `totals`. They are priced
  // as one bucket at the oldest surviving row's timestamp — the detail needed
  // to do better went with the rows, and leaving them out would make a long
  // session's total silently shrink as it grows. The cap is only ever passed
  // once rows exist, so there is always a row to date the remainder by.
  if (state.totals.calls > held.calls && turns.length > 0) {
    const rest = priced({
      model: turns[0].model ?? state.model,
      time: turns[0].time,
      ...addTokens({ ...state.totals }, held, -1),
    })
    if (rest.usd === null) allPriced = false
    else totalUsd += rest.usd
  }
  return {
    turns,
    calls: state.totals.calls,
    inputTokens: state.totals.inputTokens,
    outputTokens: state.totals.outputTokens,
    cacheReadTokens: state.totals.cacheReadTokens,
    cacheWriteTokens: state.totals.cacheWriteTokens,
    cacheWrite1hTokens: state.totals.cacheWrite1hTokens,
    totalUsd: roundCost(totalUsd),
    priced: allPriced,
    droppedTurns: state.totals.calls > held.calls,
    /**
     * The newest attempt whose usage has actually landed, as `{ turn, step }`.
     *
     * Derived from `last`, which the fold already maintains — so this adds a
     * field to the VALUE without touching the state, and costs no checkpoint
     * invalidation. The browser needs it because the live estimate travels as
     * its own frame (see {@link billLiveProjection}): at the instant a step
     * settles the two frames can arrive in either order, and this is what lets
     * the estimate be refused for a step these totals already include.
     */
    settled: state.last === null ? null : { turn: state.last.turn, step: state.last.step },
  }
}

/**
 * Standard-Schema-shaped validator for the wire payload.
 *
 * The registry's only use of `schema` is `schema.parse(view(state))`, and its
 * documented job is to stop a malformed (or accidentally async) value from
 * leaving the host. A hand-written check does that job without making zod a
 * dependency of a plugin that has no other use for one — see `hostkit.js` for
 * why a bare import of a host-profile package is not available here.
 */
const schema = {
  parse(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.turns)) {
      throw new TypeError('dsh-bill: billTurns view is not a projection value')
    }
    return value
  },
}

/**
 * Validator for a checkpointed state row, which DSH 0.1.7 parses before
 * resuming a fold from it. A row that fails is refolded from `init` instead.
 */
const stateSchema = {
  parse(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.turns)
      || !value.totals || typeof value.totals !== 'object') {
      throw new TypeError('dsh-bill: billTurns checkpoint is not a projection state')
    }
    return value
  },
}

/**
 * The unit, ready to hand to `ctx.sessionProjections.register`.
 *
 * It carries both registry shapes. DSH 0.1.5 reads `schema` and `view` off the
 * unit itself; 0.1.7 reads `stateSchema`, and pushes a value to the browser
 * only for a unit that declares `wire` — without it the projection still folds
 * host-side but `useProjection('billTurns')` never receives anything.
 */
export const billTurnsProjection = {
  key: BILL_TURNS_KEY,
  stateVersion: STATE_VERSION,
  schema,
  stateSchema,
  init,
  apply,
  view,
  wire: { viewSchema: schema, view },
}

// ── the open step, estimated ──────────────────────────────────────────────
//
// `billTurns` answers "what has this conversation cost"; it cannot answer
// "what is it costing right now", because a provider reports usage once, when
// the attempt is over. The one part of that cost whose size is visible before
// the report is the output: it is being written, on this machine, one fragment
// at a time. So the second unit folds those fragments into a character count,
// prices it at the current route, and publishes it as an ESTIMATE.
//
// Three properties make that safe, and they are the whole design:
//
//   1. **The estimate never enters a total.** `apply` here touches only its own
//      state; `totals` and the per-turn rows belong to `billTurns` and are
//      driven by provider usage alone. When the attempt settles, this unit
//      clears to null and the exact figure — which the sibling unit published
//      in the same drive pass — is what remains. There is no residue to drift,
//      because there was never anything to subtract.
//   2. **It is priced at the settled route**, through the same `priceRecord`
//      call the exact rows use, so peak/off-peak and the catalogue behave
//      identically. A model no catalogue lists prices to `null`, and the
//      browser shows nothing rather than a made-up number.
//   3. **It is deliberately a separate key.** The value is three fields, and
//      it changes many times per step; `billTurns` carries a row per turn. One
//      frame per streamed fragment re-serializing a whole conversation would be
//      the cost of putting the estimate in the same value.
//
// Only the output side is estimated. The prompt side is not: a cache-hit split
// is not observable before the provider reports it, and inventing one would be
// a guess about money rather than an estimate of content.

/** Projection key. Also the string the browser half passes to `useProjection`. */
export const BILL_LIVE_KEY = 'billLive'

/**
 * Characters per token for the estimate.
 *
 * The harness's own figure, from `dsh-token-meter`'s `estimate.ts`
 * (`CHARS_PER_TOKEN = 4`), so this plugin's live number and the harness's
 * context figures are wrong in the same direction rather than disagreeing.
 * That direction is known and documented there: the density underprices CJK
 * text and JSON, so this estimate runs low and the settled figure lands above
 * it — the only safe way for a number that is about to be replaced.
 */
const LIVE_CHARS_PER_TOKEN = 4

/**
 * Characters of output between publications of the estimate.
 *
 * `view` runs once per committed fragment, and a fragment is a few characters;
 * publishing each one would put a frame on the wire per token. A quantum of 64
 * characters is about 16 tokens — roughly one step of the last decimal a
 * cheap model's output is displayed at, and a few hundred milliseconds of a
 * normal stream — so the number still moves continuously to a reader while the
 * frames stay countable.
 */
const LIVE_PUBLISH_CHARS = 64

/**
 * Events that end the open attempt.
 *
 * Every one of them means the step in flight is finished or restarted, so the
 * estimate must be gone from that moment: `assistant/message` and
 * `assistant/attempt` carry the usage that supersedes it, `llm/retry-started`
 * and `llm/retry` redo the attempt from scratch (counting both would estimate
 * two replies), and the step/turn boundaries close it defensively for attempts
 * that settle without a message at all. No turn/step matching is needed — the
 * loop runs one attempt at a time, so any of these ends the open one.
 */
const LIVE_CLOSERS = new Set([
  'assistant/message', 'assistant/attempt', 'llm/retry', 'llm/retry-started',
  'step/end', 'turn/end', 'turn/start',
])

/** Initial live state: no route, no open attempt. */
function initLive() {
  return { model: null, turn: null, step: null, time: 0, chars: 0 }
}

/**
 * Assistant output characters carried by one streamed fragment.
 *
 * Text, thinking and tool-call arguments are all billed as output, and all
 * three stream as `assistant/chunk` fragments. The tool name is counted with
 * its arguments because it is part of the same generated JSON.
 */
function liveCharsOf(event) {
  const chunk = event.data?.chunk
  if (!chunk || typeof chunk.type !== 'string') return 0
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof chunk.text === 'string' ? chunk.text.length : 0
  }
  if (chunk.type === 'tool-call-delta') {
    return (typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0)
      + (typeof chunk.name === 'string' ? chunk.name.length : 0)
  }
  return 0
}

/** Pure transition for the live estimate. */
function applyLive(state, event) {
  if (!event || typeof event !== 'object') return state

  if (LIVE_CLOSERS.has(event.type)) {
    return state.turn === null ? state : { ...state, turn: null, step: null, time: 0, chars: 0 }
  }

  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    const model = typeof config?.model === 'string' && config.model ? config.model : null
    if (model === null || model === state.model) return state
    return { ...state, model }
  }

  const turn = Number.isFinite(event.data?.turn) ? event.data.turn : state.turn
  const step = Number.isFinite(event.data?.step) ? event.data.step : state.step

  if (event.type === 'step/start') {
    if (state.turn === turn && state.step === step) return state
    return { ...state, turn, step, time: eventTime(event), chars: 0 }
  }

  if (event.type !== 'assistant/chunk') return state
  const chars = liveCharsOf(event)
  if (chars === 0) return state
  // A fragment for a different attempt opens one: the previous attempt's
  // characters describe output that has been thrown away.
  const opened = turn !== state.turn || step !== state.step
  return {
    ...state,
    turn,
    step,
    time: opened ? eventTime(event) : state.time,
    chars: (opened ? 0 : state.chars) + chars,
  }
}

/** One event's wall-clock time, or 0 when the log carries none. */
function eventTime(event) {
  return typeof event.time === 'number' ? event.time : 0
}

/**
 * The last published live value, and the key it was built from.
 *
 * The change feed publishes a unit only when consecutive `wire.view` results
 * differ by `Object.is`, so returning the previous object is how a view
 * suppresses a frame; this is that rule with the decision made explicit —
 * the published estimate only moves when it crosses a
 * {@link LIVE_PUBLISH_CHARS} quantum. The catalogue epoch is part of the key
 * because the same count prices differently after a rate correction, and the
 * key names the whole value — two sessions streaming identical numbers produce
 * identical ones, so sharing the object costs nothing.
 */
let liveValueKey = null
let liveValue = null

/** State → the estimate the browser reads, or null when nothing is streaming. */
function liveView(state) {
  if (state.turn === null || state.chars < LIVE_PUBLISH_CHARS) return null
  const shown = Math.floor(state.chars / LIVE_PUBLISH_CHARS) * LIVE_PUBLISH_CHARS
  const outputTokens = Math.ceil(shown / LIVE_CHARS_PER_TOKEN)
  const key = pricingEpoch() + '|' + state.turn + ':' + state.step + '|' + outputTokens + '|' + state.model
  if (key === liveValueKey) return liveValue
  const cost = priced({ model: state.model ?? 'unknown', time: state.time, outputTokens })
  liveValueKey = key
  liveValue = { turn: state.turn, step: state.step, outputTokens, usd: cost.usd }
  return liveValue
}

/**
 * Standard-Schema-shaped validator for the live wire payload.
 *
 * `null` is a value here, not an absence: it is what the value is whenever no
 * attempt is streaming, and the browser reads it as "add nothing". A model
 * with no catalogue price yields `usd: null` — an unpriced estimate, which the
 * browser also adds nothing for.
 */
const liveSchema = {
  parse(value) {
    if (value === null) return value
    if (!value || typeof value !== 'object' || !Number.isFinite(value.turn) || !Number.isFinite(value.step)
      || typeof value.outputTokens !== 'number'
      || !(value.usd === null || typeof value.usd === 'number')) {
      throw new TypeError('dsh-bill: billLive view is not a live estimate')
    }
    return value
  },
}

/**
 * Validator for a checkpointed live state.
 *
 * It does more than validate: it CLEARS the open attempt, because a checkpoint
 * outlives the process that watched the stream. A character count read back
 * from disk describes an attempt nobody is writing any more — the crash case —
 * and serving it would put an estimate on screen that no settlement can ever
 * replace. Restoring closed means the fold re-opens on the first fragment of
 * whatever actually runs next; the only thing given up is the tail of an
 * attempt that will report its own usage if it ever completes. The live drive
 * keeps its own state — this runs on restore only.
 */
const liveStateSchema = {
  parse(value) {
    if (!value || typeof value !== 'object' || typeof value.chars !== 'number') {
      throw new TypeError('dsh-bill: billLive checkpoint is not a projection state')
    }
    return value.turn === null ? value : { ...value, turn: null, step: null, time: 0, chars: 0 }
  },
}

/**
 * The live unit, in both registry shapes — see {@link billTurnsProjection}.
 */
export const billLiveProjection = {
  key: BILL_LIVE_KEY,
  stateVersion: 1,
  schema: liveSchema,
  stateSchema: liveStateSchema,
  init: initLive,
  apply: applyLive,
  view: liveView,
  wire: { viewSchema: liveSchema, view: liveView },
}
