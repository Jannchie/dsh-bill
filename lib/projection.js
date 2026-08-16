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

import { priceRecord, pricingEpoch, roundCost } from './pricing.js'

/** Projection key. Also the string the browser half passes to `useProjection`. */
export const BILL_TURNS_KEY = 'billTurns'

/**
 * Bump on any change to the state shape or the fold. The framework discards
 * persisted rows stamped with a different version instead of resuming from
 * them, so a forgotten bump is a silently corrupt cost history.
 */
const STATE_VERSION = 1

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
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
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
 * Add (or, with `sign` -1, subtract) the four token buckets into `target`.
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
  const held = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
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
    totalUsd: roundCost(totalUsd),
    priced: allPriced,
    droppedTurns: state.totals.calls > held.calls,
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

/** The unit, ready to hand to `ctx.sessionProjections.register`. */
export const billTurnsProjection = {
  key: BILL_TURNS_KEY,
  stateVersion: STATE_VERSION,
  schema,
  init,
  apply,
  view,
}
