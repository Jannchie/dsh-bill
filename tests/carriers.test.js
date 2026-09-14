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

/**
 * Same cordis stub as rollup.test.js, with a Connection service added.
 *
 * `webServer.register` models the host rather than just recording calls: routes
 * live in one table for the whole host, a duplicate (kind, path) throws, and the
 * returned disposer is the only thing that removes the entry. `registry` can be
 * passed in to share that table between two boots, which is what a hot reload
 * does.
 */
function boot(handle, registry = new Map()) {
  const effects = []
  const instance = { warnings: [], routes: [], registry }
  const services = {
    webServer: {
      register: (route) => {
        const key = `${route.kind} ${route.path}`
        if (registry.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        registry.set(key, route)
        instance.routes.push(route)
        return () => { registry.delete(key) }
      },
    },
    connection: { rpc: { handle } },
  }
  const ctx = {
    ...services,
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push({ label, dispose })
      instance.dispose = dispose
      return dispose
    },
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  instance.effectFor = (label) => {
    const hit = effects.find((e) => e.label === label)
    if (!hit) throw new Error(`no effect labelled ${JSON.stringify(label)}`)
    return hit.dispose
  }
  instance.disposeAll = () => { for (const e of effects) e.dispose() }
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
// Dispose the channel's own effect by label. It used to be the last child.effect
// registered, which stopped being true once the HTTP route below was wrapped too.
working.effectFor('dsh-bill: rpc channel')()
assert(disposed, 'disposing the effect disposes the channel')

console.log('a hot reload replaces the HTTP route instead of leaking it')
// One shared route table across two boots is exactly what the host does when it
// rebuilds this plugin: the old fiber's disposer runs, then the new generation
// registers again into the same table.
{
  const registry = new Map()
  const first = boot(() => { throw new Error('no rpc here') }, registry)
  const firstApi = first.routes.find((r) => r.path === '/dsh-bill/api')
  assert(firstApi !== undefined, 'the first generation registers /dsh-bill/api')

  // Disposing owns the route only if the registration was wrapped in an effect.
  // Registered bare, this leaves the entry behind and the reload below throws
  // "duplicate exact route" — the bug this guards.
  first.disposeAll()
  assert(registry.size === 0, `disposing the old generation releases its route (table size ${registry.size})`)

  let second = null
  let threw = null
  try {
    second = boot(() => { throw new Error('no rpc here') }, registry)
  } catch (error) {
    threw = error
  }
  assert(threw === null, `the reload must not throw${threw ? ': ' + threw.message : ''}`)
  if (second) {
    const secondApi = second.routes.find((r) => r.path === '/dsh-bill/api')
    assert(secondApi !== undefined, 'the new generation registers /dsh-bill/api')
    assert(secondApi !== firstApi, 'the serving handler is the new generation, not the old one')
    assert(registry.size === 1, `the route table holds one /dsh-bill/api, not a leak (size ${registry.size})`)
  }
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
