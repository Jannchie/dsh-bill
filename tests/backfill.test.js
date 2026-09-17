/**
 * The boot-time history import must be bounded and cancellable.
 *
 * The old backfill called `readSession` once per missing session; each call
 * re-listed the ENTIRE artifact tree, and its per-read race timed out without
 * aborting, so a large home pegged a core for tens of minutes with work
 * piling up behind the deadline. The replacement lists the tree once, then
 * borrows each session's own artifact through `observeSession` with a bounded
 * worker pool, and aborts the whole pass as a unit when the
 * `backfillTimeoutMs` budget runs out.
 *
 * Run: node tests/backfill.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-backfill-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
const RECORDS_FILE = path.join(HOME, 'dsh-bill', 'records.jsonl')

const { default: plugin, Config } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, ms = 10000) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error('timed out waiting for a condition')
    await sleep(25)
  }
}

// ── config schema ────────────────────────────────────────────────────────────
console.log('config validation')
{
  const def = Config['~standard'].validate(undefined)
  assert(def.value?.maxRecords === 20000, 'maxRecords default preserved')
  assert(def.value?.backfillTimeoutMs === 60000, 'backfillTimeoutMs defaults to 60000')
  const ok = Config['~standard'].validate({ backfillTimeoutMs: 12345 })
  assert(!ok.issues && ok.value.backfillTimeoutMs === 12345, 'backfillTimeoutMs accepted as a positive integer')
  for (const bad of [-1, 0, 1.5, 'soon', NaN]) {
    const r = Config['~standard'].validate({ backfillTimeoutMs: bad })
    assert(
      r.issues?.length === 1 && r.issues[0].path?.[0] === 'backfillTimeoutMs',
      `backfillTimeoutMs rejected: ${String(bad)}`,
    )
  }
}

// ── harness ──────────────────────────────────────────────────────────────────
/**
 * One assistant step with usage, so exactly one sample per session.
 * request/header sets a fallback model/provider; the message source overrides
 * them (the same "later report wins" logic the live path uses).
 */
const USAGE_EVENTS = [
  { type: 'request/header', seq: 0, time: 1000, data: { header: { config: { model: 'm-fallback', provider: 'p-fallback' } } } },
  {
    type: 'assistant/message', seq: 1, time: 1000,
    data: {
      turn: 0, step: 0,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 },
      message: { source: { provider: 'p-src', model: 'm-src' } },
    },
  },
]

/**
 * Minimal session-query with the two methods the new backfill uses.
 * `listings` counts listing calls so a test can prove the pass ran. With
 * `hang`, `observeSession` never settles on its own — it rejects only when
 * the AbortSignal fires, mirroring the real service's observation lease.
 */
function fakeSessionQuery(sessions, { hang = false, rejectIds = [] } = {}) {
  const listings = { count: 0 }
  return {
    listings,
    async listSessions(signal) {
      signal?.throwIfAborted()
      listings.count++
      return sessions.map((s) => ({ header: { id: s.id } }))
    },
    async observeSession(id, { signal } = {}) {
      signal?.throwIfAborted()
      if (hang) {
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted', { cause: 'abort' })), { once: true })
        })
      }
      if (rejectIds.includes(id)) throw new Error('corrupt')
      const session = sessions.find((s) => s.id === id)
      return {
        events: session?.events ?? [],
        [Symbol.dispose]() {},
      }
    },
  }
}

/** Boot one plugin instance against the shared temp HOME. */
function boot(config, sessionQuery) {
  const services = { sessionQuery, webServer: { register: () => {} } }
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, config)
  return ctx
}

const readRecords = () => {
  if (!fs.existsSync(RECORDS_FILE)) return []
  return fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// ── import: one pass, one listing, one record per usage sample ──────────────
console.log('history import')
{
  const sessions = [
    { id: 'sess-a', events: USAGE_EVENTS },
    { id: 'sess-b', events: USAGE_EVENTS },
    { id: 'sess-empty', events: [] },
  ]
  const sq = fakeSessionQuery(sessions)
  boot({ maxRecords: 10 }, sq)
  const records = await waitFor(() => {
    const r = readRecords()
    return r.filter((x) => x.sessionId === 'sess-a').length === 1 && r.filter((x) => x.sessionId === 'sess-b').length === 1 ? r : null
  })
  assert(sq.listings.count === 1, 'the whole pass needed exactly one artifact listing')
  const a = records.find((r) => r.sessionId === 'sess-a')
  assert(a.source === 'log', 'imported record is marked source:log')
  assert(a.model === 'm-src' && a.provider === 'p-src', 'message source wins over the header fallback')
  assert(a.inputTokens === 10 && a.outputTokens === 20, 'input/output token counts imported')
  assert(a.cacheReadTokens === 2 && a.cacheWriteTokens === 1 && a.reasoningTokens === 3, 'cache and reasoning counts imported')
  assert(!records.some((r) => r.sessionId === 'sess-empty'), 'a session with no usage imports nothing')

  // Idempotency: a second boot on the same home imports nothing new, because
  // bySession is rebuilt from the records file before backfill runs.
  const before = readRecords().length
  const sq2 = fakeSessionQuery([{ id: 'sess-a', events: USAGE_EVENTS }])
  boot({ maxRecords: 10 }, sq2)
  await waitFor(() => (sq2.listings.count >= 1 ? true : null))
  await sleep(400)
  assert(readRecords().length === before, 'second boot imports nothing (bySession covers the session)')
}

// ── per-session rejection: corrupt sessions are skipped, not fatal ───────────
console.log('per-session rejection')
{
  const sq = fakeSessionQuery(
    [{ id: 'sess-ok', events: USAGE_EVENTS }, { id: 'sess-bad', events: USAGE_EVENTS }],
    { rejectIds: ['sess-bad'] },
  )
  boot({ maxRecords: 10 }, sq)
  const records = await waitFor(() => {
    const r = readRecords()
    return r.some((x) => x.sessionId === 'sess-ok') ? r : null
  })
  assert(!records.some((r) => r.sessionId === 'sess-bad'), 'a rejected session is skipped without failing the pass')
}

// ── budget exhaustion: the pass aborts as a unit, imports nothing ────────────
console.log('budget exhaustion')
{
  const warns = []
  const realWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  let sq
  try {
    sq = fakeSessionQuery([{ id: 'sess-hang', events: USAGE_EVENTS }], { hang: true })
    boot({ maxRecords: 10, backfillTimeoutMs: 150 }, sq)
    await waitFor(() => (sq.listings.count >= 1 ? true : null))
    await sleep(700)
  } finally {
    console.warn = realWarn
  }
  assert(warns.some((w) => w.includes('backfill') && w.includes('budget')), 'budget exhaustion is reported')
  assert(!readRecords().some((r) => r.sessionId === 'sess-hang'), 'nothing is imported after an abort')
}

// ── missing observeSession: older hosts skip the import gracefully ──────────
console.log('missing observeSession')
{
  const sq = fakeSessionQuery([{ id: 'sess-a', events: USAGE_EVENTS }])
  delete sq.observeSession
  const before = readRecords().length
  boot({ maxRecords: 10 }, sq)
  // The guard returns before listing, so this must neither hang nor list.
  await sleep(500)
  assert(sq.listings.count === 0, 'a session-query without observeSession is never listed')
  assert(readRecords().length === before, 'a session-query without observeSession skips the import')
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall backfill tests passed')
