/**
 * `periods` is a long poll: an answer carries a `rev`, and a request that
 * sends back the `rev` it holds is held until the figures would differ.
 *
 *  - an answer carries a `rev`, and one without `sinceRev` answers at once;
 *  - a held request answers when its wait runs out, with the same `rev`;
 *  - a recorded call releases it early, with a new `rev` and the new figures;
 *  - a stale `rev`, or no `waitMs`, is answered at once;
 *  - the browser going away releases a held HTTP request.
 *
 * Run: node tests/periods.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const HOME = path.join(os.tmpdir(), 'dsh-bill-periods-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** The minimal cordis stub the other tests use: the HTTP carrier and the capture hook. */
const instance = {}
const services = { webServer: { register: (r) => { instance.api = r.handler } } }
const ctx = {
  ...services,
  effect: (fn) => fn(),
  get: (name) => services[name],
  on: (name, fn) => { if (name === 'llm/stream') instance.stream = fn },
  inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
}
plugin.apply(ctx, {})

/** One priced call through the capture hook. */
async function spend() {
  async function* source() {
    yield { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  }
  const options = {
    provider: 'deepseek-official', model: 'deepseek-v4-pro', sessionId: 's1',
    tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  for await (const _ of instance.stream(options, () => source())) { /* drain */ }
}

/** POST a body; `res` is an EventEmitter so the handler can watch it close. */
function ask(body, res = new EventEmitter()) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  return new Promise((resolve) => {
    res.writeHead = () => {}
    res.end = (text) => { res.writableEnded = true; resolve(JSON.parse(text)) }
    instance.api(req, res)
  })
}
const timed = async (promise) => {
  const started = Date.now()
  const value = await promise
  return { value, ms: Date.now() - started }
}

await new Promise((r) => setTimeout(r, 200))

console.log('an answer carries a rev')
const first = await timed(ask({ action: 'periods' }))
assert(typeof first.value.rev === 'string' && first.value.rev.length > 0, 'periods answers with a rev (' + first.value.rev + ')')
assert(first.value.periods && typeof first.value.periods.day === 'number', 'and the figures')
assert(first.value.fx && first.value.unit === 'USD', 'and the fx table, like every answer')

console.log('a held request answers when its wait runs out')
const idle = await timed(ask({ action: 'periods', sinceRev: first.value.rev, waitMs: 300 }))
assert(idle.ms >= 280, 'it was held for its wait (' + idle.ms + ' ms)')
assert(idle.value.rev === first.value.rev, 'and answers with the same rev')

console.log('a recorded call releases it early')
const held = timed(ask({ action: 'periods', sinceRev: first.value.rev, waitMs: 5000 }))
await new Promise((r) => setTimeout(r, 100))
await spend()
const moved = await held
assert(moved.ms < 1500, 'it answered soon after the call (' + moved.ms + ' ms)')
assert(moved.value.rev !== first.value.rev, 'with a new rev')
assert(moved.value.periods.day > first.value.periods.day, 'and the new spend (' + moved.value.periods.day + ')')

console.log('anything else answers at once')
const stale = await timed(ask({ action: 'periods', sinceRev: first.value.rev, waitMs: 5000 }))
assert(stale.ms < 200 && stale.value.rev === moved.value.rev, 'a stale rev is answered at once (' + stale.ms + ' ms)')
const noWait = await timed(ask({ action: 'periods', sinceRev: moved.value.rev }))
assert(noWait.ms < 200, 'so is a request without waitMs (' + noWait.ms + ' ms)')

console.log('the browser going away releases a held HTTP request')
const res = new EventEmitter()
const dropped = timed(ask({ action: 'periods', sinceRev: moved.value.rev, waitMs: 5000 }, res))
await new Promise((r) => setTimeout(r, 100))
res.emit('close')
const released = await dropped
assert(released.ms < 1000, 'a closed response stops the wait (' + released.ms + ' ms)')

fs.rmSync(HOME, { recursive: true, force: true })
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
process.exit(0)
