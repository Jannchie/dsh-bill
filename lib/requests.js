/**
 * Per-request billing for DeepSeek's web Search and Fetch services.
 *
 * Unlike every other record in this plugin, these are not token calls: the
 * vendor bills them per successful HTTP request. The published list price is
 * CNY 5 per 1000 successful requests. The 2026-10-22 pricing page also says
 * that harness traffic reaching Search/Fetch through the Messages API's
 * server-side `web_search` tool is not charged until 2026-11-01 00:00 Beijing
 * time, while the standalone Search/Fetch API has no such grace period.
 *
 * Two properties shape the code below.
 *
 *   1. **Price at the request's own timestamp.** This plugin never re-prices
 *      history. `requestRateAt(kind, at, route, mode)` is the only place that
 *      decides the rate, and it is a pure function of its arguments — the
 *      session projection calls it while folding a durable log, the capture
 *      path calls it live, and both get the same answer for the same instant.
 *   2. **A request record is a billing line, not a model call.** Records carry
 *      `kind: 'request'`; the folds count them separately from model calls and
 *      keep them out of the token buckets. Stored fields mirror the model
 *      records so the ring, the rollup and the JSONL file need no second
 *      schema: zero token buckets, `usd` already priced, `peak: null`.
 *
 * Currency: the vendor publishes Search/Fetch in CNY, while the plugin's whole
 * internal basis is USD. The DeepSeek token cards in `llm-pricing` convert at a
 * fixed 1 CNY = 0.15 USD, so request fees use the same ratio rather than a live
 * rate: CNY 0.005 -> USD 0.00075. The dashboard converts the stored USD back to
 * the user's currency with its own live FX table, exactly like token costs, so
 * this choice only affects the internal number, not display.
 *
 * This module is pure and dependency-free on purpose: it is imported by the
 * host capture path (`index.js`) AND by the session projection
 * (`projection.js`), which must stay synchronous and replay-safe.
 *
 * @module dsh-bill/requests
 */

/** The two billable web services. Ids are a storage format — do not rename. */
export const WEB_REQUEST_KINDS = ['search', 'fetch']

/** Model ids used in records and in the ring's per-model keys. */
export const WEB_REQUEST_MODEL = { search: 'web-search', fetch: 'web-fetch' }

/** Display names the report can show without a catalogue lookup. */
export const WEB_REQUEST_DISPLAY = { search: 'DeepSeek Search', fetch: 'DeepSeek Fetch' }

/** Purpose ids, matching the record's `purpose` field. */
export const WEB_REQUEST_PURPOSE = { search: 'search', fetch: 'fetch' }

/** Provider id stored on request records (distinguishes them from model routes). */
const WEB_REQUEST_PROVIDER = 'deepseek'

/**
 * The provider ids whose calls DeepSeek bills. The route is stored on every
 * record so the history stays auditable after the web settings change, and so a
 * future vendor price change can be applied to the right route.
 */
export const SEARCH_MESSAGES_ROUTE = 'deepseek-official'
export const SEARCH_API_ROUTE = 'deepseek-search-api'
export const FETCH_API_ROUTE = 'deepseek-fetch-api'

/**
 * How request fees treat the vendor's announced grace window.
 *
 *   - `vendor` (default): reproduce the published rules. Messages-route search
 *     is free until the cutoff, then billed; the standalone Search/Fetch API is
 *     billed from launch.
 *   - `reference`: price every successful request from its first call, so the
 *     report answers "what would this cost" immediately. Useful for budgeting;
 *     totals then intentionally run ahead of the account bill.
 */
export const WEB_REQUEST_PRICING_MODES = ['vendor', 'reference']
export const DEFAULT_WEB_REQUEST_PRICING = 'vendor'

/** Published price in CNY per 1000 successful requests. */
export const REQUEST_PRICE_CNY_PER_THOUSAND = { search: 5, fetch: 5 }

/**
 * Fixed CNY -> USD ratio used by the DeepSeek cards in the pricing catalogue.
 * 0.02 CNY (cache-hit, per Mtok) is stored as 0.003 USD there, so one CNY is
 * 0.15 USD for both token and request pricing. See the module comment.
 */
export const CNY_TO_USD = 0.15

/** Published fee converted to the plugin's USD basis (0.00075 for both kinds). */
export const REQUEST_PRICE_USD = {
  search: REQUEST_PRICE_CNY_PER_THOUSAND.search / 1000 * CNY_TO_USD,
  fetch: REQUEST_PRICE_CNY_PER_THOUSAND.fetch / 1000 * CNY_TO_USD,
}

/**
 * End of the vendor's grace window: 2026-11-01T00:00:00+08:00.
 *
 * Only the Messages-route search uses it; the standalone API is billed from
 * launch. See the 2026-10-22 pricing page.
 */
export const REQUEST_FREE_UNTIL_MS = Date.UTC(2026, 9, 31, 16, 0, 0)

/** True when `kind` names a billable web service. */
export function isWebRequestKind(kind) {
  return kind === 'search' || kind === 'fetch'
}

/** True when `mode` names a supported pricing mode. */
export function isWebRequestPricingMode(mode) {
  return mode === 'vendor' || mode === 'reference'
}

/** Billed-always schedule for one kind. */
function billedSchedule(kind) {
  return [{ from: Number.NEGATIVE_INFINITY, usd: REQUEST_PRICE_USD[kind], reason: 'published' }]
}

/**
 * The vendor's Messages-route search schedule: free until the cutoff, then the
 * published price.
 */
const MESSAGES_SEARCH_SCHEDULE = [
  { from: Number.NEGATIVE_INFINITY, usd: 0, reason: 'messages-free-window' },
  { from: REQUEST_FREE_UNTIL_MS, usd: REQUEST_PRICE_USD.search, reason: 'published' },
]

/** Schedules, keyed by kind and route, for the vendor-accurate mode. */
const VENDOR_SCHEDULES = {
  search: {
    [SEARCH_MESSAGES_ROUTE]: MESSAGES_SEARCH_SCHEDULE,
    [SEARCH_API_ROUTE]: billedSchedule('search'),
    // A route this module does not know is treated as the standalone product:
    // a new provider id must not silently inherit the Messages free window.
    default: billedSchedule('search'),
  },
  fetch: {
    [FETCH_API_ROUTE]: billedSchedule('fetch'),
    default: billedSchedule('fetch'),
  },
}

/** Schedules for reference pricing: everything billed from the epoch. */
const REFERENCE_SCHEDULES = {
  search: {
    [SEARCH_MESSAGES_ROUTE]: billedSchedule('search'),
    [SEARCH_API_ROUTE]: billedSchedule('search'),
    default: billedSchedule('search'),
  },
  fetch: {
    [FETCH_API_ROUTE]: billedSchedule('fetch'),
    default: billedSchedule('fetch'),
  },
}

/**
 * The schedule for one kind/route pair in one mode.
 *
 * An OMITTED route means the caller cannot say which provider served the
 * request: the session projection replaying a durable log, or a test. It then
 * uses the shipped default route (Messages-route search), which is the one the
 * published grace window describes. A NAMED route is the provider that actually
 * ran and is matched exactly.
 */
function scheduleFor(kind, route, mode) {
  const schedules = mode === 'reference' ? REFERENCE_SCHEDULES : VENDOR_SCHEDULES
  const byRoute = schedules[kind]
  if (route === undefined || route === null || route === '') {
    return kind === 'search' ? byRoute[SEARCH_MESSAGES_ROUTE] : byRoute.default
  }
  return byRoute[route] ?? byRoute.default
}

/**
 * The rate in force for one request kind at one instant.
 *
 * @param kind - 'search' | 'fetch'
 * @param at - epoch milliseconds
 * @param route - serving provider id, when known
 * @param mode - 'vendor' | 'reference' (defaults to vendor)
 * @returns { usd, reason } — never null.
 */
export function requestRateAt(kind, at, route, mode) {
  const pricing = isWebRequestPricingMode(mode) ? mode : DEFAULT_WEB_REQUEST_PRICING
  const schedule = scheduleFor(isWebRequestKind(kind) ? kind : 'search', route, pricing)
  const time = Number.isFinite(at) ? at : Date.now()
  let current = schedule[0]
  for (const period of schedule) {
    if (period.from <= time) current = period
    else break
  }
  return { usd: current.usd, reason: current.reason }
}


/**
 * Build one priced request record.
 *
 * Token buckets are zero rather than absent so every fold can read them
 * unconditionally, and `base`/`peak` are null because there is no per-token
 * rate card or peak schedule for a per-request fee. `sessionId` is omitted
 * when unknown, mirroring the model-call records.
 *
 * @param spec - { seq, kind, time, sessionId?, route?, mode? }
 * @returns a record ready for the ring, the rollup and records.jsonl.
 */
export function makeWebRequestRecord(spec) {
  const kind = isWebRequestKind(spec?.kind) ? spec.kind : 'search'
  const time = Number.isFinite(spec?.time) ? spec.time : Date.now()
  const route = typeof spec?.route === 'string' && spec.route.length > 0 ? spec.route : undefined
  const mode = isWebRequestPricingMode(spec?.mode) ? spec.mode : DEFAULT_WEB_REQUEST_PRICING
  const rate = requestRateAt(kind, time, route, mode)
  const rec = {
    seq: spec?.seq ?? 0,
    time,
    kind: 'request',
    provider: WEB_REQUEST_PROVIDER,
    model: WEB_REQUEST_MODEL[kind],
    displayName: WEB_REQUEST_DISPLAY[kind],
    purpose: WEB_REQUEST_PURPOSE[kind],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    usd: rate.usd,
    priced: true,
    base: null,
    peak: null,
  }
  if (typeof spec?.sessionId === 'string' && spec.sessionId.length > 0) rec.sessionId = spec.sessionId
  // Which provider served the request, so the history can be audited after the
  // setting changes. Omitted when unknown (e.g. a record built from a log).
  if (route !== undefined) rec.route = route
  // False for the Messages search route, whose single request can run several
  // server-side searches: the stored count is then a lower bound, not exact.
  if (route === SEARCH_MESSAGES_ROUTE) rec.countExact = false
  if (mode === 'reference') rec.pricingMode = mode
  // The fee is a service charge, not prompt content; it still gets an
  // attribution entry so the attribute tree's "Web requests" slice and the
  // coverage sentence account for the money. A free-window request contributes
  // nothing to attribute, so it stays without one.
  if (rate.usd > 0) rec.attr = { [`web|${WEB_REQUEST_MODEL[kind]}`]: rate.usd }
  return rec
}

