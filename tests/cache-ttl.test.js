/**
 * The capture path keeps the one-hour cache-write split a usage report carries.
 *
 * A route that asks the provider for the one-hour cache gets back how many of
 * its writes were one-hour writes; the adapter reports that as
 * `cacheWrite1hTokens`. Captured calls must store it and price it, and calls
 * without it must be stored exactly as before.
 *
 * Run: node tests/cache-ttl.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-cache-ttl-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

const instance = {}
const services = { webServer: { register: (r) => { instance.api = r.handler } } }
const ctx = {
  ...services,
  effect: (fn) => fn(),
  get: (name) => services[name],
  on: (name, fn) => { if (name === 'llm/stream') instance.stream = fn },
  inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
}
plugin.apply(ctx, {
  priceOverrides: { 'ttl-test-model': { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 } },
})
await new Promise((r) => setTimeout(r, 200))

async function call(sessionId, usage) {
  async function* source() {
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'usage', usage }
  }
  const options = {
    provider: 'anthropic', model: 'ttl-test-model', sessionId,
    system: 'S', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  for await (const _ of instance.stream(options, () => source())) { /* drain */ }
}
async function ask(body) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await instance.api(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }
await call('short', base)
await call('long', { ...base, cacheWrite1hTokens: 1_000_000 })

const short = await ask({ action: 'dashboard', rangeDays: 0, sessionId: 'short' })
const long = await ask({ action: 'dashboard', rangeDays: 0, sessionId: 'long' })
assert(Math.abs(short.totalUsd - 5) < 1e-6, 'five-minute writes bill at the card rate (got ' + short.totalUsd + ')')
assert(long.totalUsd > short.totalUsd, 'the same writes reported as one-hour cost more (' + long.totalUsd + ' > ' + short.totalUsd + ')')

await new Promise((r) => setTimeout(r, 300))
const lines = fs.readFileSync(path.join(HOME, 'dsh-bill', 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const stored = Object.fromEntries(lines.map((r) => [r.sessionId, r]))
assert(stored.long.cacheWrite1hTokens === 1_000_000, 'the split is stored on the record')
assert(!('cacheWrite1hTokens' in stored.short), 'a call without the split stores no extra field')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
fs.rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
