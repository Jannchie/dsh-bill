/**
 * Smoke tests for the browser half.
 *
 * `node --check` only parses; it happily accepts a module body that throws the
 * moment it runs. These tests EVALUATE the module against a stub React and
 * assert the two dictionaries stay in step, which is how a half-finished
 * find-and-replace gets caught here instead of in the settings panel.
 *
 * Run: node tests/client.test.js
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

console.log('module evaluates')
let exported = null
globalThis.document = { querySelector: () => null }
globalThis.window = {
  __ModuleLoader__: {
    load: (mod) => {
      exported = mod.factory(() => ({
        createElement: () => null,
        useState: () => [null, () => {}],
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
      }))
    },
  },
}
await import(clientPath)
assert(exported !== null, 'the module loader factory ran')
assert(typeof exported.apply === 'function', 'exports apply()')
assert(Array.isArray(exported.inject) && exported.inject.includes('slots'), 'injects the slots service')

console.log('slot registrations')
// Running apply() against a stub slot registry proves the seats this half
// claims — a typo in a slot key never renders and never errors, so the only
// place it can be caught is here.
const registered = []
const seats = []
exported.apply({
  get: (name) => (name === 'slots'
    ? {
        inject: (key, effect) => { seats.push(key); effect() },
        register: (options) => { registered.push(options); return () => {} },
      }
    : undefined),
  effect: () => {},
})
const seatOf = (name) => registered.find((o) => o.name === name)
for (const key of [
  'conversation.composer.dock',
  'conversation.chat.turnTail',
  'conversation.view',
  'settings.section',
  'sidebar.footer.action',
]) {
  assert(seatOf(key) !== undefined, 'registers into ' + key)
  assert(seats.includes(key), 'waits for ' + key + ' to be declared before registering')
}
// A chain seat without a selector never elects, and the framework has no
// default: the entry would silently never render.
assert(typeof seatOf('conversation.chat.turnTail')?.select === 'function',
  'the turn-tail entry carries the mandatory chain selector')
// The selector must be pure over the owner props and must decline an open
// turn, which has no final usage to report yet.
const select = seatOf('conversation.chat.turnTail').select
assert(select({ turn: { turn: 3, status: 'closed' }, seq: 9 })?.turn === 3, 'a closed turn elects, carrying its number')
assert(select({ turn: { turn: 3, status: 'open' }, seq: 9 }) === null, 'an open turn declines')
assert(select({}) === null, 'a missing turn declines rather than throwing')
// List seats need a stable id; two entries sharing one id at the same priority
// is a registration error, not a shadowing.
for (const key of ['conversation.view', 'settings.section', 'sidebar.footer.action', 'conversation.composer.dock']) {
  assert(typeof seatOf(key).id === 'string' && seatOf(key).id.length > 0, key + ' declares an id')
}
// Labels are thunks so a language switch re-reads them without re-registering.
assert(typeof seatOf('conversation.view').label === 'function', 'the view tab label is a thunk')
assert(typeof seatOf('settings.section').label === 'function', 'the settings nav label is a thunk')

console.log('dictionaries')
// Read the keys off the source: the dictionaries are module-private, and this
// stays a pure lint over what ships rather than an API widened for tests.
const source = readFileSync(clientPath, 'utf8')
function dictKeys(name) {
  const start = source.indexOf('var ' + name + ' = {')
  if (start < 0) return null
  const end = source.indexOf('\n    }', start)
  const body = source.slice(start, end)
  return new Set([...body.matchAll(/^\s{6}'([^']+)':/gm)].map((m) => m[1]))
}
const zh = dictKeys('DICT_ZH')
const en = dictKeys('DICT_EN')
assert(zh !== null && zh.size > 50, 'DICT_ZH found with ' + (zh ? zh.size : 0) + ' keys')
assert(en !== null && en.size > 50, 'DICT_EN found with ' + (en ? en.size : 0) + ' keys')
if (zh && en) {
  const missingEn = [...zh].filter((k) => !en.has(k))
  const missingZh = [...en].filter((k) => !zh.has(k))
  // The locale service rejects an unbalanced registration at runtime, which
  // would take the whole page down; catching it here is strictly cheaper.
  assert(missingEn.length === 0, 'every zh key has an en translation' + (missingEn.length ? ': missing ' + missingEn.join(', ') : ''))
  assert(missingZh.length === 0, 'every en key has a zh translation' + (missingZh.length ? ': missing ' + missingZh.join(', ') : ''))
}

console.log('dictionary values are literals')
// A global find-and-replace over UI strings once rewrote the dictionary's own
// values into `t(...)` calls, which throws at module scope. Values must be
// plain strings.
const dictBodies = source.slice(source.indexOf('var DICT_ZH'), source.indexOf('function fallbackT'))
assert(!/':\s*t\(/.test(dictBodies), 'no dictionary value calls t()')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
