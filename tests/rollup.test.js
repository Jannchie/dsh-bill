/**
 * Eviction must not make the all-time total go down, and a restart must not
 * make it go up.
 *
 * The ring evicts after a few months of ordinary use, so this path is
 * otherwise unreachable in a test; the `maxRecords` config shrinks the ring to
 * make it reachable in seconds.
 *
 * Run: node tests/rollup.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-rollup-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

/**
 * Start one plugin instance against the shared DSH_HOME.
 *
 * The stub mirrors the two cordis mechanisms the plugin depends on: `get` for
 * an optional probe, and `inject(names, cb)` for a child fiber that starts
 * only once every named service exists. `webServer` is the only one this fake
 * assembly provides, so the RPC and projection children never start — which is
 * also the assertion that their absence costs nothing.
 */
function boot(maxRecords = 10) {
  const instance = {}
  const services = {
    webServer: { register: (r) => { instance.api = r.handler } },
  }
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: (name, fn) => { if (name === 'llm/stream') instance.stream = fn },
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, { maxRecords })
  return instance
}
let { stream, api } = boot()

/** Run one call through the stream wrapper and return. Does NOT flush. */
async function recordOne(target, when) {
  const realNow = Date.now
  Date.now = () => when
  async function* source() {
    yield { type: 'text-delta', index: 0, text: 'W'.repeat(100) }
    yield { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  }
  const options = {
    provider: 'deepseek-official', model: 'deepseek-v4-pro', sessionId: 's1',
    system: 'S'.repeat(500), tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  for await (const _ of target(options, () => source())) { /* drain */ }
  Date.now = realNow
}

async function call(when) {
  await recordOne(stream, when)
  // Drain the persist queue before the next call lands, so eviction sees a
  // persistedCount that is current: a record the ring has already folded into
  // the rollup must have reached the file first to count as a dead prefix, or
  // the fileSkip math diverges from what the file actually holds.
  await ask({ action: 'flush' })
}
async function ask(body, handler = api) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await handler(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

const base = Date.UTC(2026, 7, 10)
const drained = await ask({ action: 'flush' })
assert(drained && drained.ok === true && drained.drained === true,
  'a flush drains the persist queue and acknowledges (got ' + JSON.stringify(drained) + ')')
console.log('all-time total survives eviction')
for (let i = 0; i < 5; i++) await call(base + i * 3600_000)
const five = await ask({ action: 'dashboard', rangeDays: 0 })
assert(five.calls === 5, 'five calls recorded')

console.log('the session tab reports its own session only')
const s1 = await ask({ action: 'dashboard', rangeDays: 0, sessionId: 's1' })
const other = await ask({ action: 'dashboard', rangeDays: 0, sessionId: 's-other' })
assert(s1.calls === 5 && other.calls === 0, 'each session counts only its own calls (got ' + s1.calls + ', ' + other.calls + ')')
assert(s1.periods === null && s1.forecast === null && s1.bySession.length === 0, 'account-wide figures are left out of a session report')
const all = await ask({ action: 'dashboard', rangeDays: 0 })
assert(all.calls === 5 && all.periods !== null, 'the global report still counts every session')
const perCall = five.totalUsd / 5

// Twenty-five more: the ring holds 10, so 20 get folded into the rollup.
for (let i = 5; i < 30; i++) await call(base + i * 3600_000)
const thirty = await ask({ action: 'dashboard', rangeDays: 0 })
assert(thirty.calls === 30, 'all 30 calls counted, not just the 10 still held (got ' + thirty.calls + ')')
assert(near(thirty.totalUsd, perCall * 30), 'total is 30x one call, i.e. nothing was dropped')
assert(thirty.totalUsd > five.totalUsd, 'the all-time total never went down')

console.log('rolled-up detail still reaches the breakdowns')
const model = (thirty.byModel || [])[0]
assert(model && model.calls === 30, 'per-model row carries all 30 calls (got ' + (model && model.calls) + ')')
assert(near((thirty.byPurpose || []).reduce((s, r) => s + r.usd, 0), thirty.totalUsd), 'by-purpose sums to the total')
assert(near((thirty.timelineDays || []).reduce((s, d) => s + d.usd, 0), thirty.totalUsd), 'the daily timeline sums to the total')
assert(thirty.archived && thirty.archived.calls === 20, 'archived count is reported (got ' + (thirty.archived && thirty.archived.calls) + ')')

console.log('what was written to disk')
const rollupPath = path.join(HOME, 'dsh-bill', 'rollup.json')
const jsonl = path.join(HOME, 'dsh-bill', 'records.jsonl')
// Drain before reading: the persist queue is async, so the file and the
// rollup are only coherent once it has flushed. Polling the file for
// stability (the old settle) raced the queue under load; a drain is exact.
await ask({ action: 'flush' })
assert(fs.existsSync(rollupPath), 'rollup.json written')
const saved = JSON.parse(fs.readFileSync(rollupPath, 'utf8'))
assert(saved.calls === 20, 'rollup holds the 20 evicted calls (got ' + saved.calls + ')')
const text = fs.readFileSync(jsonl, 'utf8')
const lines = text.trim().split('\n')
assert(lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }), 'every line is valid JSON')
// Eviction leaves the dead lines in place rather than rewriting the file, so
// the file is the live ring plus whatever prefix the rollup has absorbed.
assert(lines.length === saved.fileSkip + 10, 'file is fileSkip(' + saved.fileSkip + ') + the 10 live records (got ' + lines.length + ')')
// The identity above holds whatever the flush does — drop the per-call drain
// and BOTH sides shrink together, so it still passes. The exact count is what
// the drain buys, and it is the only thing that pins it.
// The run: 30 calls into a 10-record ring. Calls 11..20 each fold one record
// and leave it as a dead prefix, taking the skip to 10. Call 21 folds the
// eleventh, which crosses `fileSkip > maxRecords` and triggers the compaction
// that rewrites the file and resets the skip to 0. Calls 22..30 fold nine more,
// so the prefix ends at 9 and the file holds 9 dead lines + the 10 live ones.
// Without a per-call flush some records are folded before their append has run,
// so they never reach the file and are not counted as a dead prefix: the prefix
// comes out short of 9 and the file shorter than 19 lines. Measured: 6 and 16.
assert(saved.fileSkip === 9 && lines.length === 19,
  'the drain leaves every folded record on disk: fileSkip 9, 19 lines (got fileSkip ' + saved.fileSkip + ', ' + lines.length + ' lines)')

console.log('a restart reconstructs the same totals')
// The dead prefix must be skipped by exactly the count the rollup recorded:
// counting it again would double the bill, dropping too much would shrink it.
// Flush the writer before a second instance reads the same home: an append
// still in flight would land while the new instance's startup read runs, and
// the new ring would pick up lines the old one had not yet reconciled.
await ask({ action: 'flush' })
const restarted = boot()
await ask({ action: 'flush' }, restarted.api)
const after = await ask({ action: 'dashboard', rangeDays: 0 }, restarted.api)
assert(after.calls === 30, 'still 30 calls after a restart (got ' + after.calls + ')')
assert(near(after.totalUsd, thirty.totalUsd), 'the total is unchanged by the restart')

console.log('a dead prefix left in the file is skipped, not re-counted')
// The run above compacted (its dead prefix outgrew its ring), which resets the
// skip to zero. A wider ring keeps the prefix below the compaction threshold,
// so the file still carries dead lines at restart — the case the skip exists
// for, and the one that double-counts if the count is off.
const HOME2 = path.join(os.tmpdir(), 'dsh-bill-rollup-test-skip')
fs.rmSync(HOME2, { recursive: true, force: true })
process.env.DSH_HOME = HOME2
const wide = boot(25)
stream = wide.stream
api = wide.api
await ask({ action: 'flush' }, wide.api)
for (let i = 0; i < 30; i++) await call(base + i * 3600_000)
const before = await ask({ action: 'dashboard', rangeDays: 0 }, wide.api)
const jsonl2 = path.join(HOME2, 'dsh-bill', 'records.jsonl')
await ask({ action: 'flush' }, wide.api)
const saved2 = JSON.parse(fs.readFileSync(path.join(HOME2, 'dsh-bill', 'rollup.json'), 'utf8'))
const lines2 = fs.readFileSync(jsonl2, 'utf8').trim().split('\n')
assert(saved2.fileSkip > 0, 'the file kept a dead prefix rather than being rewritten (fileSkip ' + saved2.fileSkip + ')')
// The file is its dead prefix plus the live ring. The identity holds whatever
// the flush does, so the exact count is what pins the drain — see the note on
// the first run's equivalent. A 25-record ring over 30 calls evicts 5, and
// `fileSkip > maxRecords` never trips, so nothing rewrites the file: the 5
// evicted records are all on disk as the dead prefix, plus the 25 live ones.
assert(saved2.fileSkip === 5 && lines2.length === 30,
  'the drain leaves every folded record on disk: fileSkip 5, 30 lines (got fileSkip ' + saved2.fileSkip + ', ' + lines2.length + ' lines)')
await ask({ action: 'flush' }, wide.api)
const reread = boot(25)
await ask({ action: 'flush' }, reread.api)
const after2 = await ask({ action: 'dashboard', rangeDays: 0 }, reread.api)
assert(after2.calls === 30, 'restart counts 30, not 30 + the dead prefix (got ' + after2.calls + ')')
assert(near(after2.totalUsd, before.totalUsd), 'the total is unchanged by the restart')

console.log('a flush that outruns a single pass still reports what it saw')
// Every `call` above awaits its own stream, so a capture can never land while a
// drain is in flight — which means the assertions so far cannot tell a drain
// that re-chases the queue from one that awaits a single snapshot of it. That
// difference is the whole reason a drain loops: persist() reassigns
// persistQueue, so a record captured mid-drain is queued behind the very
// promise being awaited and a one-pass reader walks away from it still on disk.
// The race is only reachable with captures in flight, so run them without
// awaiting and flush in the middle.
const HOME3 = path.join(os.tmpdir(), 'dsh-bill-rollup-test-drain')
fs.rmSync(HOME3, { recursive: true, force: true })
process.env.DSH_HOME = HOME3
const racing = boot(25)
const pending = []
for (let i = 0; i < 30; i++) pending.push(recordOne(racing.stream, base + i * 3600_000))
// A drain issued now, while those 30 captures are still resolving.
const raced = await ask({ action: 'flush' }, racing.api)
await Promise.all(pending)
// Whatever the race decided, the claim under test is that the drain says
// whether it got a clean stop. A loop that only ever runs one pass can never
// report `drained: false`; one that loops without a bound can never return at
// all under a steady capture stream.
assert(raced && raced.ok === true && typeof raced.drained === 'boolean',
  'a flush reports whether it drained (got ' + JSON.stringify(raced) + ')')
// Once the captures have all resolved, a further drain must reach a quiet queue
// and the file must then hold every record the ring ever took in.
const settled = await ask({ action: 'flush' }, racing.api)
assert(settled && settled.drained === true, 'a flush after the captures land reports a clean drain (got ' + JSON.stringify(settled) + ')')
// These 30 captures were NOT drained one at a time, so 5 of them are folded
// into the rollup before their append has run — and a record folded that way
// never reaches the file at all. So the file is the 25-record ring plus a dead
// prefix of however many of the evicted ones had landed, which is exactly the
// shape the identity allows. What must hold after a clean drain is that the
// file is coherent with the rollup: every line parses, and nothing is claimed
// as a dead prefix that is not physically there.
const jsonl3 = path.join(HOME3, 'dsh-bill', 'records.jsonl')
const text3 = fs.readFileSync(jsonl3, 'utf8')
const lines3 = text3.trim().split('\n')
const saved3 = JSON.parse(fs.readFileSync(path.join(HOME3, 'dsh-bill', 'rollup.json'), 'utf8'))
assert(lines3.every((l) => { try { JSON.parse(l); return true } catch { return false } }), 'the drained file is entirely valid JSON')
assert(lines3.length === saved3.fileSkip + 25,
  'the drained file is its dead prefix plus the live ring (fileSkip ' + saved3.fileSkip + ', ' + lines3.length + ' lines)')
// And a restart off that file still reconstructs the truth: the dead prefix
// skipped by the rollup and the ring are disjoint, so no call is counted twice.
const raceRestart = boot(25)
await ask({ action: 'flush' }, raceRestart.api)
const racedAfter = await ask({ action: 'dashboard', rangeDays: 0 }, raceRestart.api)
assert(racedAfter.calls === 30, 'a restart over the raced file still counts 30 (got ' + racedAfter.calls + ')')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
