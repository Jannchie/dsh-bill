/**
 * The two carriers must be independent: a Connection service whose
 * `rpc.handle` throws (DSH 0.1.5, where it resolves `webServer` through the
 * wrong fiber — issue #1) must not take the HTTP route with it, and must say
 * so rather than dying quietly inside its child fiber.
 *
 * Run: node tests/carriers.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-carriers-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** Same cordis stub as rollup.test.js, with a Connection service added. */
function boot(handle) {
  const instance = { warnings: [], routes: [] }
  const services = {
    webServer: { register: (r) => { instance.routes.push(r) } },
    connection: { rpc: { handle } },
  }
  const ctx = {
    ...services,
    effect: (fn) => { instance.dispose = fn() },
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  const warn = console.warn
  console.warn = (...args) => instance.warnings.push(args.join(' '))
  try {
    plugin.apply(ctx, {})
  } finally {
    console.warn = warn
  }
  return instance
}

async function ask(handler, body) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await handler(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

console.log('rpc.handle throws (DSH 0.1.5)')
let broken = null
try {
  broken = boot(() => { throw new Error('cannot get property "webServer" without inject') })
} catch (error) {
  assert(false, 'apply() must not throw: ' + error.message)
}
if (broken) {
  const api = broken.routes.find((r) => r.path === '/dsh-bill/api')
  assert(api !== undefined, 'POST /dsh-bill/api is still registered')
  assert(broken.warnings.some((w) => /dsh-bill.*rpc channel/.test(w)), 'the missing channel is reported, not swallowed')
  assert(broken.warnings.some((w) => /without inject/.test(w)), 'the warning carries the cause')
  const pong = api && await ask(api.handler, { action: 'ping' })
  assert(pong && pong.ok === true, 'the HTTP route answers')
  assert(typeof broken.dispose === 'function', 'the effect still returns a disposer')
}

console.log('rpc.handle works')
let disposed = false
const mounted = {}
const working = boot((channel, handler) => {
  mounted.channel = channel
  mounted.rpc = handler
  return () => { disposed = true }
})
assert(mounted.channel === '/dsh-bill', 'the channel is registered')
assert(working.warnings.length === 0, 'nothing is warned about')
const viaRpc = await mounted.rpc('ping', {})
assert(viaRpc.ok === true && viaRpc.value.ok === true, 'the channel dispatches to the same actions')
working.dispose()
assert(disposed, 'disposing the effect disposes the channel')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
