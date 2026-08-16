/**
 * Eviction must not make the all-time total go down.
 *
 * The ring evicts after a few months of ordinary use, so this path is
 * otherwise unreachable in a test; `DSH_BILL_MAX_RECORDS` shrinks the ring to
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
process.env.DSH_BILL_MAX_RECORDS = '10'

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

let stream = null
let api = null
plugin.apply({
  effect: () => {}, get: () => undefined,
  on: (name, fn) => { if (name === 'llm/stream') stream = fn },
  webServer: { register: (r) => { api = r.handler } },
}, {})

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
async function ask(body) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await api(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

const base = Date.UTC(2026, 7, 10)
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

console.log('the rollup survives a restart')
const rollupPath = path.join(HOME, 'dsh-bill', 'rollup.json')
await new Promise((r) => setTimeout(r, 200))
assert(fs.existsSync(rollupPath), 'rollup.json written')
const saved = JSON.parse(fs.readFileSync(rollupPath, 'utf8'))
assert(saved.calls === 20, 'rollup holds the 20 evicted calls (got ' + saved.calls + ')')

console.log('the records file is appended, not rewritten')
const jsonl = path.join(HOME, 'dsh-bill', 'records.jsonl')
// Writes are queued behind an async chain; wait for the file to stop changing
// rather than guessing a delay.
let previous = ''
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 50))
  const now = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, 'utf8') : ''
  if (now === previous && now !== '') break
  previous = now
}
const lines = previous.trim().split('\n')
assert(lines.length === 10, 'file holds exactly the live ring after eviction (got ' + lines.length + ')')
assert(lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }), 'every line is valid JSON')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
