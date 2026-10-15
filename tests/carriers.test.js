/**
 * `POST /dsh-bill/api` is the one carrier. The Connection RPC channel is not
 * registered at all — `rpc.handle` cannot mount for a plugin (it resolves
 * `webServer` through the Connection plugin's own fiber — issue #1) — so a host
 * that offers `connection` must see no call to it and no warning about it.
 * The route must also survive a hot reload without leaking.
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
function boot(registry = new Map(), config = {}) {
  const effects = []
  const instance = { warnings: [], routes: [], registry, injected: [], handled: [] }
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
    connection: { rpc: { handle: (...args) => { instance.handled.push(args); return () => {} } } },
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
    inject: (names, apply) => { instance.injected.push(...names); if (names.every((n) => services[n])) apply(ctx) },
  }
  instance.disposeAll = () => { for (const e of effects) e.dispose() }
  const warn = console.warn
  console.warn = (...args) => instance.warnings.push(args.join(' '))
  try {
    plugin.apply(ctx, config)
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

console.log('one carrier')
{
  const host = boot()
  const api = host.routes.find((r) => r.path === '/dsh-bill/api')
  assert(api !== undefined, 'POST /dsh-bill/api is registered')
  assert(host.handled.length === 0, 'no RPC channel is asked for, though the host offers connection')
  assert(host.warnings.length === 0, 'nothing is warned about')
  const pong = api && await ask(api.handler, { action: 'ping' })
  assert(pong && pong.ok === true, 'the HTTP route answers')
}

console.log('a hot reload replaces the HTTP route instead of leaking it')
// One shared route table across two boots is exactly what the host does when it
// rebuilds this plugin: the old fiber's disposer runs, then the new generation
// registers again into the same table.
{
  const registry = new Map()
  const first = boot(registry)
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
    second = boot(registry)
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

console.log('agentTool: false leaves bill_stats unregistered')
// The tool list is the front of the prompt-cache prefix, so the only cache-safe
// way to keep the schema off requests is to never ask for the registry at all.
{
  const withTool = boot()
  assert(withTool.injected.includes('tools'), 'by default the plugin asks for the tool registry')
  const without = boot(new Map(), { agentTool: false })
  assert(!without.injected.includes('tools'), 'with agentTool: false it never asks for the tool registry')
  assert(without.routes.some((r) => r.path === '/dsh-bill/api'), 'the HTTP carrier is still mounted')
  assert(without.warnings.length === 0, 'nothing is warned about')
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
