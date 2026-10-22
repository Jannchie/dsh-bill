/**
 * The host side of per-request web Search / Fetch billing.
 *
 * The capture seam is the `web` service, and the two properties worth pinning
 * down are:
 *
 *   - only requests that reach a DeepSeek-billed provider are counted, and a
 *     failed call is not billed;
 *   - one seam call is one billing line — including across two plugin
 *     generations sharing the service during a reload.
 *
 * Run: node tests/web-requests.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-web-requests-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('offline web-requests test') }
const realNow = Date.now

const { default: plugin, Config } = await import('../lib/index.js')
const {
  FETCH_API_ROUTE, REQUEST_FREE_UNTIL_MS, REQUEST_PRICE_USD, SEARCH_API_ROUTE, SEARCH_MESSAGES_ROUTE,
} = await import('../lib/requests.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}
function near(actual, expected, msg, eps = 1e-12) {
  assert(Math.abs(actual - expected) <= eps, `${msg} (got ${actual}, want ${expected})`)
}


function okEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${actual}, want ${expected})`)
}
function okRow(row, msg) {
  assert(row !== undefined, msg ?? 'row exists')
}

const USD = REQUEST_PRICE_USD.search
const FREE = REQUEST_FREE_UNTIL_MS
let clock = Date.UTC(2026, 9, 22, 12) // before the grace cutoff
Date.now = () => clock

/** A mutable, provider-shaped `web` service. */
function makeWeb() {
  const providers = { searchProvider: 'deepseek-official', fetchProvider: 'http' }
  const behaviour = {
    search: async () => ({ sources: [], truncated: false }),
    fetch: async (request) => ({ url: request.url, statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }),
  }
  const service = {
    config: {
      searchProvider: { get: () => providers.searchProvider },
      fetchProvider: { get: () => providers.fetchProvider },
    },
    searchProviders: new Map([['deepseek-official', {}], ['deepseek-search-api', {}]]),
    fetchProviders: new Map([['http', {}], ['deepseek-fetch-api', {}]]),
    search: (...args) => behaviour.search(...args),
    fetch: (...args) => behaviour.fetch(...args),
  }
  return { service, providers, behaviour, originals: { search: service.search, fetch: service.fetch } }
}

/** Boot one plugin generation against the shared services. */
function boot(services, config = {}) {
  const effects = []
  const instance = { routes: [], warnings: [], home: services.home }
  const all = {
    web: services.web.service,
    agents: services.web.agents ?? { currentInitiator: () => ({ session: { id: 'session-web' } }) },
    webServer: {
      register: (route) => {
        instance.routes.push(route)
        return () => {}
      },
    },
    sessionProjections: { register: () => () => {} },
  }
  const ctx = {
    ...all,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    get: (name) => all[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => all[n])) apply(ctx) },
  }
  instance.disposeAll = () => { for (const dispose of effects) dispose() }
  const warn = console.warn
  console.warn = (...args) => instance.warnings.push(args.join(' '))
  try {
    plugin.apply(ctx, {
      agentTool: false,
      backfillTimeoutMs: 1000,
      dshHome: services.home,
      ...config,
    })
  } finally {
    console.warn = warn
  }
  instance.api = instance.routes.find((route) => route.path === '/dsh-bill/api')
  return instance
}

async function ask(handler, body) {
  const req = { on: (event, fn) => { if (event === 'data') fn(JSON.stringify(body)); if (event === 'end') fn() } }
  let out = null
  await handler(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

async function dashboard(host, body = { rangeDays: 0 }) {
  return ask(host.api.handler, { action: 'dashboard', ...body })
}

function rowOf(rows, predicate) {
  return rows.find(predicate)
}

console.log('config exposes the switch and the pricing mode')
{
  const validate = (input) => Config['~standard'].validate(input)
  eq(validate({ webRequests: false }).value.webRequests, false, 'webRequests false passes through')
  eq(validate({ webRequestPricing: 'reference' }).value.webRequestPricing, 'reference', 'reference mode passes through')
  eq(validate({}).value.webRequestPricing, 'vendor', 'vendor is the default')
  for (const bad of ['free', 'VENDOR', 1]) {
    assert(validate({ webRequestPricing: bad }).issues?.[0]?.path?.[0] === 'webRequestPricing',
      `webRequestPricing ${JSON.stringify(bad)} is refused, naming the field`)
  }
  assert(validate({ webRequests: 'yes' }).issues?.[0]?.path?.[0] === 'webRequests', 'a non-boolean webRequests is refused')
}

console.log('vendor mode: only DeepSeek-billed requests are counted, per route')
{
  const web = makeWeb()
  const host = boot({ web, home: path.join(HOME, 'vendor') })
  assert(host.api !== undefined, 'the HTTP API is mounted')

  // Messages-route search inside the grace window: recorded, priced at zero.
  await web.service.search({ query: 'a' })
  // ...and after the cutoff: still a request, now billed.
  clock = FREE
  await web.service.search({ query: 'b' })
  // A second query in a multi-query tool call is another seam call.
  await web.service.search({ query: 'c' })

  // Local HTTP fetch never reaches DeepSeek billing.
  await web.service.fetch({ url: 'https://example.com/by-local' })
  eq((await dashboard(host)).requests, 3, 'three searches recorded, local fetch ignored')

  // The standalone APIs are billed from launch.
  web.providers.searchProvider = SEARCH_API_ROUTE
  await web.service.search({ query: 'd' })
  web.providers.fetchProvider = FETCH_API_ROUTE
  await web.service.fetch({ url: 'https://example.com/by-api' })
  const bill = await dashboard(host)
  eq(bill.requests, 5, 'Search API search and Fetch API fetch are counted')
  near(bill.requestUsd, 4 * USD, 'only the four billed requests carry money (second/third/fourth/fifth)')
  eq(bill.byPurpose.find((row) => row.purpose === 'search').calls, 4, 'search purpose counts the requests')
  okRow(bill.byPurpose.find((row) => row.purpose === 'fetch'), 'fetch purpose exists')
  const modelRow = rowOf(bill.byModel, (row) => row.kind === 'request' && row.model === 'web-search')
  assert(modelRow !== undefined, 'the by-model table names the request service')
  eq(modelRow.calls, 0, 'request rows do not count as model calls')
  eq(modelRow.requests, 4, 'request rows count requests')
  eq(modelRow.countExact, false, 'the Messages route lowers the exactness bound for the model row')
  eq(bill.calls, 0, 'model-call total excludes request lines')

  // A failed request is not billed.
  web.behaviour.search = async () => { throw new Error('provider failed') }
  let threw = false
  try { await web.service.search({ query: 'e' }) } catch { threw = true }
  assert(threw, 'the provider failure reaches the caller')
  eq((await dashboard(host)).requests, 5, 'a failed request is not recorded')

  // The record reached the JSONL store.
  let lines = []
  for (let attempt = 0; attempt < 40; attempt++) {
    try { lines = fs.readFileSync(path.join(host.home, 'dsh-bill', 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) } catch { /* not yet */ }
    if (lines.length >= 5) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const requests = lines.filter((line) => line.kind === 'request')
  eq(requests.length, 5, 'all request lines persisted')
  const free = requests.find((line) => line.usd === 0)
  assert(free !== undefined && free.countExact === false && free.route === SEARCH_MESSAGES_ROUTE,
    'the free Messages-route line persists its route and lower-bound marker')
  assert(requests.every((line) => line.provider === 'deepseek' && line.inputTokens === 0), 'persisted lines keep the request shape')
}

console.log('reference mode bills every successful request from its first call')
{
  const web = makeWeb()
  const host = boot({ web, home: path.join(HOME, 'reference') }, { webRequestPricing: 'reference' })
  clock = FREE - 12345
  await web.service.search({ query: 'ref' })
  const bill = await dashboard(host)
  eq(bill.requests, 1, 'pre-cutoff search recorded')
  near(bill.requestUsd, USD, 'reference mode charges before the vendor grace window')
}

console.log('webRequests: false leaves the seam alone')
{
  const web = makeWeb()
  const host = boot({ web, home: path.join(HOME, 'disabled') }, { webRequests: false })
  await web.service.search({ query: 'off' })
  eq(web.service.search, web.originals.search, 'the seam is not wrapped')
  eq((await dashboard(host)).requests, 0, 'nothing recorded')
}

console.log('overlapping generations: the newest counts, and stays alive when the old one goes')
{
  const web = makeWeb()
  const home = path.join(HOME, 'double')
  const first = boot({ web, home })
  const second = boot({ web, home })
  await web.service.search({ query: 'once' })
  eq((await dashboard(first)).requests, 0, 'the older generation does not count while it is covered')
  eq((await dashboard(second)).requests, 1, 'the newest generation counts the call')
  first.disposeAll()
  await web.service.search({ query: 'after-first-dispose' })
  eq((await dashboard(second)).requests, 2, 'disposing the OLD generation must not silence the new one')
  okEq(web.service.search !== web.originals.search, true, 'the seam is still wrapped after the old generation disposes')
  second.disposeAll()
  await web.service.search({ query: 'after-all-dispose' })
  eq(web.service.search, web.originals.search, 'disposing the last generation hands the seam back')
  eq((await dashboard(second)).requests, 2, 'a disposed generation records nothing more')
}

console.log('no web service: the plugin still applies and reports nothing for web')
{
  const host = boot({ web: { service: undefined }, home: path.join(HOME, 'no-web') })
  assert(host.api !== undefined, 'the HTTP API is mounted without a web service')
  const bill = await dashboard(host)
  eq(bill.requests, 0, 'no requests when there is no seam to wrap')
  assert(Number.isFinite(bill.totalUsd), 'the rest of the report still works')
}

console.log('provider fallback: the environment and a single usable registered provider')
{
  const web = makeWeb()
  web.providers.searchProvider = undefined
  process.env.DSH_WEB_SEARCH_PROVIDER = SEARCH_API_ROUTE
  try {
    const host = boot({ web, home: path.join(HOME, 'env-fallback') })
    await web.service.search({ query: 'env' })
    near((await dashboard(host)).requestUsd, USD, 'the env override selects a billed route')
  } finally {
    delete process.env.DSH_WEB_SEARCH_PROVIDER
  }
}
{
  const web = makeWeb()
  web.providers.searchProvider = undefined
  web.service.searchProviders = new Map([[SEARCH_API_ROUTE, { id: SEARCH_API_ROUTE, available: () => true }]])
  web.service.fetchProviders = new Map([['http', { id: 'http', available: () => true }]])
  const host = boot({ web, home: path.join(HOME, 'registry-fallback') })
  await web.service.search({ query: 'registry' })
  near((await dashboard(host)).requestUsd, USD, 'a single usable registered provider is detected')
}

console.log('old records and an old rollup load without losing the new request lines')
{
  const home = path.join(HOME, 'legacy')
  const dir = path.join(home, 'dsh-bill')
  fs.mkdirSync(dir, { recursive: true })
  const oldRecord = {
    seq: 0, time: FREE - 86_400_000, sessionId: 'session-old', provider: 'deepseek-official',
    model: 'deepseek-v4-flash', purpose: 'agent', inputTokens: 1000, outputTokens: 100,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, usd: 0.0001, priced: true,
    displayName: 'DeepSeek V4 Flash', base: null, peak: 'offpeak',
  }
  fs.writeFileSync(path.join(dir, 'records.jsonl'), JSON.stringify(oldRecord) + '\n')
  fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify({
    calls: 1, usd: 0.01, priced: true, uncachedInputTokens: 10, cacheReadTokens: 0,
    cacheWriteTokens: 0, outputTokens: 10, peakUsd: 0, offPeakUsd: 0.01, peakCalls: 0,
    offPeakCalls: 1, byModel: {}, byPurpose: {}, byDay: {}, attr: {}, fileSkip: 0,
  }))
  const web = makeWeb()
  const host = boot({ web, home })
  await web.service.search({ query: 'legacy' })
  const bill = await dashboard(host)
  eq(bill.requests, 1, 'the new request line is counted')
  near(bill.requestUsd, 0, 'a Messages-route request inside the grace window is free')
  assert(Number.isFinite(bill.totalUsd), 'old records and rollup still produce a finite total')
  assert(bill.byPurpose.find((row) => row.purpose === 'search') !== undefined, 'the search purpose row survives a legacy load')
}

Date.now = realNow
globalThis.fetch = realFetch
fs.rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
