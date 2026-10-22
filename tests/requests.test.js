/**
 * The per-request web Search / Fetch schedule.
 *
 * The vendor's published notice has two halves — a per-request price and a
 * grace window that applies only to Messages-route server-side searches — so
 * the schedule has to answer three questions correctly:
 *
 *   - which route served the request,
 *   - when it was served (the grace cutoff is an instant, not a day),
 *   - which pricing mode the plugin instance is in (the vendor rules, or
 *     reference pricing that deliberately bills from the first call).
 *
 * Run: node tests/requests.test.js
 */
import {
  CNY_TO_USD, DEFAULT_WEB_REQUEST_PRICING, FETCH_API_ROUTE, REQUEST_FREE_UNTIL_MS,
  REQUEST_PRICE_CNY_PER_THOUSAND, REQUEST_PRICE_USD, SEARCH_API_ROUTE, SEARCH_MESSAGES_ROUTE,
  WEB_REQUEST_MODEL, WEB_REQUEST_PRICING_MODES, isWebRequestKind, isWebRequestPricingMode,
  makeWebRequestRecord, requestRateAt,
} from '../lib/requests.js'

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
function near(actual, expected, msg, eps = 1e-12) {
  assert(Math.abs(actual - expected) <= eps, `${msg} (got ${actual}, want ${expected})`)
}

const USD = REQUEST_PRICE_USD.search
assert(USD === 0.00075, 'published CNY 5 / 1000 converts to USD 0.00075 at the catalogue ratio')
assert(REQUEST_PRICE_CNY_PER_THOUSAND.fetch === 5, 'Fetch is published at the same per-thousand price')
assert(Math.abs(CNY_TO_USD - 0.15) < 1e-12, 'the fixed conversion is 1 CNY = 0.15 USD')
assert(REQUEST_FREE_UNTIL_MS === Date.UTC(2026, 9, 31, 16, 0, 0), 'grace window ends 2026-11-01T00:00+08:00')
assert(DEFAULT_WEB_REQUEST_PRICING === 'vendor', 'the default mode reproduces the published rules')
assert(WEB_REQUEST_PRICING_MODES.join(',') === 'vendor,reference', 'both pricing modes are known')
assert(isWebRequestKind('search') && isWebRequestKind('fetch') && !isWebRequestKind('model'), 'kind guard')
assert(isWebRequestPricingMode('vendor') && isWebRequestPricingMode('reference') && !isWebRequestPricingMode('nope'), 'mode guard')

console.log('vendor mode: the grace window applies to Messages-route search only')
const FREE = REQUEST_FREE_UNTIL_MS
near(requestRateAt('search', FREE - 1, SEARCH_MESSAGES_ROUTE, 'vendor').usd, 0, 'Messages search is free one ms before the cutoff')
near(requestRateAt('search', FREE, SEARCH_MESSAGES_ROUTE, 'vendor').usd, USD, 'Messages search is billed from the cutoff')
near(requestRateAt('search', 0, SEARCH_MESSAGES_ROUTE, 'vendor').usd, 0, 'Messages search is free at the epoch')
near(requestRateAt('search', FREE - 1, SEARCH_API_ROUTE, 'vendor').usd, USD, 'Search API is billed before the cutoff')
near(requestRateAt('search', 0, SEARCH_API_ROUTE, 'vendor').usd, USD, 'Search API is billed from launch')
near(requestRateAt('fetch', FREE - 1, FETCH_API_ROUTE, 'vendor').usd, USD, 'Fetch API is billed before the cutoff')
near(requestRateAt('fetch', 0, FETCH_API_ROUTE, 'vendor').usd, USD, 'Fetch API is billed from launch')
near(requestRateAt('search', FREE - 1, 'some-new-provider', 'vendor').usd, USD, 'an unknown NAMED search route is billed, not given the grace window')
near(requestRateAt('search', FREE - 1, undefined, 'vendor').usd, 0, 'an OMITTED search route is priced as the shipped Messages default')
near(requestRateAt('fetch', FREE - 1, undefined, 'vendor').usd, USD, 'an omitted fetch route is billed')
assert(requestRateAt('search', FREE, SEARCH_MESSAGES_ROUTE, 'vendor').reason === 'published', 'billed rate carries the published reason')
assert(requestRateAt('search', FREE - 1, SEARCH_MESSAGES_ROUTE, 'vendor').reason === 'messages-free-window', 'free window carries its own reason')
assert(requestRateAt('search', 0, SEARCH_MESSAGES_ROUTE).reason === 'messages-free-window', 'an omitted mode defaults to vendor')

console.log('reference mode: every request is billed from its first call')
for (const [kind, route] of [
  ['search', SEARCH_MESSAGES_ROUTE], ['search', SEARCH_API_ROUTE], ['search', undefined],
  ['fetch', FETCH_API_ROUTE], ['fetch', undefined],
]) {
  const label = `${kind}/${route ?? 'omitted'}`
  near(requestRateAt(kind, 0, route, 'reference').usd, USD, `${label} is billed at the epoch under reference pricing`)
  near(requestRateAt(kind, FREE - 1, route, 'reference').usd, USD, `${label} ignores the grace window under reference pricing`)
}
assert(requestRateAt('search', 0, SEARCH_MESSAGES_ROUTE, 'reference').reason === 'published', 'reference pricing reports the published fee')
near(requestRateAt('search', 0, SEARCH_MESSAGES_ROUTE, 'bogus-mode').usd, 0, 'an unknown mode falls back to vendor rules')
near(requestRateAt('search', FREE, SEARCH_MESSAGES_ROUTE, 'vendor').usd, USD, 'a search at the cutoff is billed')

console.log('a request record is a billing line, not a model call')
const rec = makeWebRequestRecord({ seq: 7, kind: 'search', time: FREE - 1, sessionId: 's1', route: SEARCH_MESSAGES_ROUTE, mode: 'vendor' })
assert(rec.kind === 'request' && rec.provider === 'deepseek', 'identity fields')
assert(rec.model === WEB_REQUEST_MODEL.search && rec.purpose === 'search', 'model and purpose ids')
assert(rec.usd === 0 && rec.priced === true, 'a free-window request is priced at zero, not "unpriced"')
assert(rec.base === null && rec.peak === null, 'no per-token rate card and no peak tag')
assert(rec.inputTokens === 0 && rec.outputTokens === 0 && rec.cacheReadTokens === 0
  && rec.cacheWriteTokens === 0 && rec.reasoningTokens === 0, 'token buckets are zero')
assert(rec.sessionId === 's1' && rec.route === SEARCH_MESSAGES_ROUTE, 'session and route are stored for audit')
assert(rec.countExact === false, 'the Messages route is marked as a lower-bound count')
assert(rec.pricingMode === undefined, 'vendor mode is not stamped on the record')
assert(!('attr' in rec), 'a zero-fee request has nothing to attribute')

const paid = makeWebRequestRecord({ seq: 8, kind: 'fetch', time: FREE, route: FETCH_API_ROUTE })
assert(paid.usd === USD && paid.countExact === undefined, 'a billed fetch is exact and priced')
near(paid.attr['web|web-fetch'], USD, 'a billed request carries its attribution entry')
near(makeWebRequestRecord({ seq: 9, kind: 'search', time: FREE - 1, route: SEARCH_MESSAGES_ROUTE, mode: 'reference' }).usd, USD,
  'reference mode prices a pre-cutoff Messages request')
assert(makeWebRequestRecord({ seq: 10, kind: 'search', time: 0, route: SEARCH_API_ROUTE, mode: 'reference' }).pricingMode === 'reference',
  'the record stamps the pricing mode when it is not the default')
assert(!('sessionId' in makeWebRequestRecord({ seq: 11, kind: 'fetch', time: FREE })), 'an absent session id is omitted, not undefined')
assert(makeWebRequestRecord({}).kind === 'request' && makeWebRequestRecord({}).purpose === 'search', 'a sparse spec still yields a valid request record')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
