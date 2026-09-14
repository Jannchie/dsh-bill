/**
 * End-to-end check of the lazy-tool listener wiring in lib/index.js.
 *
 * `lazy.js` is unit-tested on its own; what this file proves is the part the
 * unit tests cannot see: that the plugin actually registers a
 * `system-prompt/assemble` listener, that the listener reads the preference
 * (not a config snapshot), and that a preference written through the
 * `prefs-set` action changes the very next request's tool list.
 *
 * Run: node tests/lazy-integration.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-lazy-integration')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** Boot the plugin against the same minimal stub the other tests use. */
function boot() {
  const instance = {}
  const services = { webServer: { register: (r) => { instance.api = r.handler } } }
  const listeners = []
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: (event, handler) => { if (event === 'system-prompt/assemble') listeners.push(handler) },
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, {})
  instance.listeners = listeners
  return instance
}

const app = boot()
await new Promise((r) => setTimeout(r, 250))

async function ask(body) {
  let out = null
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  await new Promise((resolve) => {
    app.api(req, { writeHead() {}, end(text) { out = JSON.parse(text); resolve() } })
  })
  return out
}

/**
 * Run the assembly waterfall the way dsh-agent-loop does: the listener is the
 * outermost handler and `next()` resolves to the tools the model would get.
 */
const deriveCount = { value: 0 }
/**
 * Entries may be plain strings (user text) or raw message objects (e.g. a
 * tool-result shape), so the window semantics can be exercised end to end.
 */
function toMessages(entries) {
  return entries.map((entry) => typeof entry === 'string'
    ? { role: 'user', content: [{ type: 'text', text: entry }] }
    : entry)
}
async function assemble(userTexts) {
  const tools = [{ name: 'read' }, { name: 'bill_stats' }, { name: 'write' }]
  const context = {
    agent: {
      session: {
        deriveMessages: () => { deriveCount.value++; return toMessages(userTexts) },
      },
    },
  }
  const handler = app.listeners[0]
  assert(typeof handler === 'function', 'the plugin registered its assemble listener')
  const assembled = await handler({ tools: tools.slice() }, context, () => Promise.resolve({ tools: tools.slice() }))
  return assembled.tools.map((tool) => tool.name)
}

console.log('the lookback is 6 by default (provide on demand)')
assert(app.listeners.length === 1, 'the listener is mounted unconditionally (so a later change is live)')
let names = await assemble(['how much did this cost?'])
assert(names.includes('bill_stats'), 'with the default window a matching request keeps bill_stats')

console.log('an unrelated request loses the tool with a positive lookback')
names = await assemble(['帮我重构一下这个模块'])
assert(!names.includes('bill_stats'), 'an unrelated request loses bill_stats (got ' + names.join(',') + ')')
assert(names.includes('read') && names.includes('write'), 'every other tool is untouched')

console.log('a zero window hides the tool from every request, matching or not')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 0 } })
const derivesBefore = deriveCount.value
names = await assemble(['这个会话花了多少钱'])
assert(deriveCount.value === derivesBefore, 'a 0 window skips the message-history derivation entirely (no per-request overhead)')
assert(!names.includes('bill_stats'), 'with a 0 window even a matching request never gets bill_stats (got ' + names.join(',') + ')')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 6 } })

console.log('and reveals it for a matching request')
names = await assemble(['这个会话花了多少钱'])
assert(names.includes('bill_stats'), 'a cost question keeps bill_stats')

console.log('the lookback window is honored')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 1 } })
names = await assemble(['这个会话花了多少钱', '继续'])
assert(!names.includes('bill_stats'), 'a match two messages back is outside a window of 1 (got ' + names.join(',') + ')')
names = await assemble(['继续', '这个会话花了多少钱'])
assert(names.includes('bill_stats'), 'a fresh match is inside the window of 1 (got ' + names.join(',') + ')')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 6 } })

console.log('a tool result does not consume a lookback slot')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 1 } })
names = await assemble(['这个会话花了多少钱', { role: 'user', content: [{ type: 'tool-result', callId: 'x', name: 'bill_stats' }] }])
assert(names.includes('bill_stats'), 'with a window of 1 the question still matches: the trailing text-less tool result did not consume the slot (got ' + names.join(',') + ')')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 6 } })

console.log('the built-in pattern is the shipped keyword set, as one regex')
names = await assemble(['What did this session cost?'])
assert(names.includes('bill_stats'), 'English "cost" matches out of the box')
names = await assemble(['show token 消耗 please'])
assert(names.includes('bill_stats'), 'the spaced token-usage form matches out of the box')

console.log('a custom pattern replaces the built-in one')
const written = await ask({ action: 'prefs-set', patch: { lazyToolsPattern: '发票|invoice' } })
assert(written.ok === true && written.prefs.lazyToolsPattern === '发票|invoice', 'the custom pattern is stored')
names = await assemble(['这个会话花了多少钱'])
assert(!names.includes('bill_stats'), 'the old keyword no longer matches')
names = await assemble(['给我看看发票'])
assert(names.includes('bill_stats'), 'the new pattern matches')

console.log('an invalid pattern is refused and changes nothing')
const refused = await ask({ action: 'prefs-set', patch: { lazyToolsPattern: '(' } })
assert(refused.ok === false && refused.error === 'invalid-pattern', 'the write is refused')
const reread = await ask({ action: 'prefs' })
assert(reread.prefs.lazyToolsPattern === '发票|invoice', 'the stored pattern is untouched')
names = await assemble(['给我看看发票'])
assert(names.includes('bill_stats'), 'and the refusal left matching behaviour intact')

console.log('an empty pattern means "always provide" (when the window is positive)')
await ask({ action: 'prefs-set', patch: { lazyToolsPattern: '' } })
names = await assemble(['帮我重构一下这个模块'])
assert(names.includes('bill_stats'), 'clearing the pattern disables the hiding')
console.log('the lookback is read per request, not at registration')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 0 } })
names = await assemble(['帮我重构一下这个模块'])
assert(!names.includes('bill_stats'), 'setting the window back to 0 hides the tool immediately (got ' + names.join(',') + ')')
names = await assemble(['这个会话花了多少钱'])
assert(!names.includes('bill_stats'), 'and with 0 even a matching request is hidden (got ' + names.join(',') + ')')

console.log('a judgement failure never breaks the prompt')
await ask({ action: 'prefs-set', patch: { lazyToolsLookback: 6 } })
const brokenContext = { agent: { session: { deriveMessages: () => { throw new Error('boom') } } } }
const tools = [{ name: 'bill_stats' }]
const survived = await app.listeners[0]({ tools }, brokenContext, () => Promise.resolve({ tools: tools.slice() }))
assert(Array.isArray(survived.tools), 'the listener still resolves a tool list')

fs.rmSync(HOME, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
