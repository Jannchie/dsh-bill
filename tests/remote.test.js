/**
 * The spend stream (lib/remote.js): its body, its Host Service, and the Client
 * contribution the browser half restates.
 *
 * Run: node tests/remote.test.js
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  SPEND_REMOTE_CONTRIBUTION, SPEND_REMOTE_METHOD, SPEND_REMOTE_SERVICE, nextChange, spendRemoteService, spendWatch,
} from '../lib/remote.js'

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** A ring stand-in: a version, and the wakers `subscribe` hands out. */
function ring() {
  const waiters = new Set()
  const state = { version: 0, ready: 0 }
  return {
    state,
    bump() { state.version++; for (const wake of [...waiters]) wake() },
    waiters,
    source: {
      ready: async () => { state.ready++ },
      key: () => String(state.version),
      snapshot: (key) => ({ rev: Number(key) }),
      subscribe: (wake) => { waiters.add(wake); return () => waiters.delete(wake) },
      minGapMs: 20,
    },
  }
}

console.log('the stream opens with the current state')
{
  const r = ring()
  const controller = new AbortController()
  const it = spendWatch(r.source)(controller.signal)
  const first = await it.next()
  assert(r.state.ready === 1, 'waits for the host to be ready first')
  assert(first.value?.rev === 0, 'the first item is the state as it stands')

  console.log('and yields again only when the state moves')
  let second = null
  it.next().then((step) => { second = step })
  await tick(60)
  assert(second === null, 'an unchanged ring yields nothing')
  assert(r.waiters.size === 1, 'it waits on the ring, not on a timer')
  r.bump()
  await tick(10)
  assert(second?.value?.rev === 1, 'a change is pushed')

  console.log('a burst is one item')
  let third = null
  it.next().then((step) => { third = step })
  r.bump(); r.bump(); r.bump()
  await tick(5)
  assert(third === null, 'nothing inside the minimum gap')
  await tick(40)
  assert(third?.value?.rev === 4, 'then one item carrying the newest state')

  console.log('cancellation ends it')
  let last = null
  it.next().then((step) => { last = step })
  await tick(30)
  controller.abort()
  await tick(5)
  assert(last?.done === true, 'the iteration completes when the signal aborts')
  assert(r.waiters.size === 0, 'and leaves no waker behind')
}

console.log('the wait also ends at local midnight')
{
  const controller = new AbortController()
  const before = new Date(2026, 0, 1, 23, 59, 59, 900)
  const started = Date.now()
  let unsubscribed = false
  await nextChange(() => () => { unsubscribed = true }, controller.signal, before)
  const waited = Date.now() - started
  assert(waited >= 900 && waited < 2500, `a day boundary wakes the stream (${waited} ms)`)
  assert(unsubscribed, 'and the waker is withdrawn')
}

console.log('the Host Service carries a typert binding and one stream marker')
{
  // The decorator contract @deepseek-ai/dsh-typert-protocol implements:
  // `Remote({ mode })` returns a standard method decorator whose initializer
  // marks the instance's prototype.
  const marks = []
  class TypertRemoteService {
    constructor(ctx, name) { this.ctx = ctx; this.name = name; this.typertRemote = { serviceKey: name, namespace: name } }
  }
  const Remote = (options) => (method, context) => {
    assert(options.mode === 'stream' && context.name === SPEND_REMOTE_METHOD && context.kind === 'method'
      && context.static === false && context.private === false, 'decorated as a public stream method')
    context.addInitializer(function () { marks.push({ prototype: Object.getPrototypeOf(this), method: context.name }) })
  }
  const watch = async function* (signal) { yield { signal } }
  const Service = spendRemoteService({ Remote, TypertRemoteService }, watch)
  const signal = new AbortController().signal
  const service = new Service({ id: 'ctx' })
  assert(service.typertRemote.namespace === SPEND_REMOTE_SERVICE, 'bound to the dshBill namespace')
  assert(marks.length === 1 && marks[0].prototype === Service.prototype && marks[0].method === 'watch', 'the constructor runs the marker')
  const src = Function.prototype.toString.call(Service.prototype.watch)
  assert(/^watch\(signal\)/.test(src), 'its only parameter is the cancellation signal (the Gateway reads the source)')
  const item = await service.watch(signal).next()
  assert(item.value.signal === signal, 'and it delegates to the stream body')
}

console.log('the browser restates the same contribution')
{
  let exported = null
  globalThis.window = { __ModuleLoader__: { load: (mod) => { exported = mod.factory(() => ({ createElement: () => null })) } } }
  const here = dirname(fileURLToPath(import.meta.url))
  await import(pathToFileURL(join(here, '..', 'lib', 'client.js')).href + '?remote')
  assert(JSON.stringify(exported?.spendRemote) === JSON.stringify(SPEND_REMOTE_CONTRIBUTION), 'client.js and remote.js agree')
  const [descriptor] = SPEND_REMOTE_CONTRIBUTION.descriptors
  assert(descriptor.parameters.length === 0 && descriptor.mode === 'stream', 'no Client-supplied field, so no codec is needed')
  assert(readFileSync(join(here, '..', 'package.json'), 'utf8').includes('lib/remote.js'), 'the check script parses remote.js')
}

if (failed) {
  console.error(`\n${failed} FAILED`)
  process.exit(1)
}
console.log('\nall passed')
