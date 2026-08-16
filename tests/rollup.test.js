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

/** Start one plugin instance against the shared DSH_HOME. */
function boot(maxRecords = 10) {
  const instance = {}
  plugin.apply({
    effect: () => {}, get: () => undefined,
    on: (name, fn) => { if (name === 'llm/stream') instance.stream = fn },
    webServer: { register: (r) => { instance.api = r.handler } },
  }, { maxRecords })
  return instance
}
let { stream, api } = boot()

async function call(when) {
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
  for await (const _ of stream(options, () => source())) { /* drain */ }
  Date.now = realNow
}
async function ask(body, handler = api) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await handler(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

/** Wait until the queued writes stop changing a file (they are async). */
async function settle(file) {
  let previous = ''
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50))
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (now === previous && now !== '') return now
    previous = now
  }
  return previous
}

/** Let the startup read finish — writes are suppressed until it has. */
const ready = () => new Promise((r) => setTimeout(r, 200))

const base = Date.UTC(2026, 7, 10)
await ready()
console.log('all-time total survives eviction')
for (let i = 0; i < 5; i++) await call(base + i * 3600_000)
const five = await ask({ action: 'dashboard', rangeDays: 0 })
assert(five.calls === 5, 'five calls recorded')
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
const text = await settle(jsonl)
await new Promise((r) => setTimeout(r, 100))
assert(fs.existsSync(rollupPath), 'rollup.json written')
const saved = JSON.parse(fs.readFileSync(rollupPath, 'utf8'))
assert(saved.calls === 20, 'rollup holds the 20 evicted calls (got ' + saved.calls + ')')
const lines = text.trim().split('\n')
assert(lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }), 'every line is valid JSON')
// Eviction leaves the dead lines in place rather than rewriting the file, so
// the file is the live ring plus whatever prefix the rollup has absorbed.
assert(lines.length === saved.fileSkip + 10, 'file is fileSkip(' + saved.fileSkip + ') + the 10 live records (got ' + lines.length + ')')

console.log('a restart reconstructs the same totals')
// The dead prefix must be skipped by exactly the count the rollup recorded:
// counting it again would double the bill, dropping too much would shrink it.
const restarted = boot()
await new Promise((r) => setTimeout(r, 300))
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
await ready()
for (let i = 0; i < 30; i++) await call(base + i * 3600_000)
const before = await ask({ action: 'dashboard', rangeDays: 0 }, wide.api)
const jsonl2 = path.join(HOME2, 'dsh-bill', 'records.jsonl')
await settle(jsonl2)
await new Promise((r) => setTimeout(r, 100))
const saved2 = JSON.parse(fs.readFileSync(path.join(HOME2, 'dsh-bill', 'rollup.json'), 'utf8'))
const lines2 = fs.readFileSync(jsonl2, 'utf8').trim().split('\n')
assert(saved2.fileSkip > 0, 'the file kept a dead prefix rather than being rewritten (fileSkip ' + saved2.fileSkip + ')')
// The file is its dead prefix plus the live ring. It can hold fewer than every
// record ever seen: a record evicted before its append ran never reached the
// file at all, and is accounted for in the rollup instead.
assert(lines2.length === saved2.fileSkip + 25, 'file is fileSkip(' + saved2.fileSkip + ') + the 25 live records (got ' + lines2.length + ')')
const reread = boot(25)
await new Promise((r) => setTimeout(r, 300))
const after2 = await ask({ action: 'dashboard', rangeDays: 0 }, reread.api)
assert(after2.calls === 30, 'restart counts 30, not 30 + the dead prefix (got ' + after2.calls + ')')
assert(near(after2.totalUsd, before.totalUsd), 'the total is unchanged by the restart')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
