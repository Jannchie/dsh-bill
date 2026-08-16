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
// A DOM stub with a real `head`, so the stylesheet injection runs here rather
// than being skipped: the sheet carries every hover, focus and disabled state
// in the plugin, and a module that silently declined to append it would look
// identical to one that appended it correctly.
//
// `querySelector` answers from `appended` rather than always returning null, so
// the module's own "is it already there?" guard is the thing under test — a
// stub that always says "not present" would pass whether the guard existed or
// not, and a second evaluation (hot reload) is exactly when it matters.
const appended = []
globalThis.document = {
  querySelector: (sel) => {
    const key = /data-plugin-css="([^"]+)"/.exec(sel)?.[1]
    return appended.find((node) => node.dataset.pluginCss === key) ?? null
  },
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (node) => appended.push(node) },
}
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

// Read the source once: several checks below are lints over what ships rather
// than over an API widened for tests.
const source = readFileSync(clientPath, 'utf8')

console.log('stylesheet')
// The sheet is how this plugin gets the interactive states the shipped
// controls have. It must land, be keyed the way the host keys its own (so a
// reload replaces rather than stacks it), and address only prefixed classes —
// an unprefixed rule here would restyle the whole app.
assert(appended.length === 1, 'exactly one <style> tag is appended (got ' + appended.length + ')')
const sheet = appended[0]
assert(sheet.dataset.pluginCss === 'dsh-bill/bill.css', 'keyed on data-plugin-css')
assert(sheet.dataset.plugin === 'dsh-bill', 'attributed to this plugin')
const css = sheet.textContent
// Strip comments and unwrap the @media block, then read the text before each
// `{` as a selector list — commas inside declarations (font stacks, easing
// curves) make a single regex over the whole sheet unusable.
const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
const selectors = [...flat.matchAll(/([^{}]+)\{/g)]
  .flatMap((m) => m[1].split(','))
  .map((s) => s.trim()).filter(Boolean)
const foreign = selectors.filter((s) => !s.startsWith('.dshbill-'))
assert(foreign.length === 0, 'every selector is scoped to .dshbill-*: ' + foreign.join(' | '))
// Hover without focus-visible is a mouse-only affordance; the shipped controls
// carry both, and a keyboard user must be able to see where they are.
assert(/:hover/.test(css) && /:focus-visible/.test(css), 'declares both hover and focus-visible states')

console.log('type ramp')
// Every size comes from the design system's composite font tokens — no literal
// that happens to look right, anywhere. The one off-ramp step this plugin needs
// (the dock's 12px/20px, copied from the shipped StatsLine) lives in the sheet
// as a CSS rule, exactly as upstream ships it, so the JS side is absolute.
const sizes = [...source.matchAll(/fontSize:\s*\d+/g)]
assert(sizes.length === 0, 'no hand-set font size remains (got ' + sizes.map((m) => m[0]).join(', ') + ')')
// Published steps, from the theme's design-platform tokens.
const RAMP = new Set(['xxxs-11', 'xxxs-strong-11', 'xxs-12', 'xxs-strong-12', 'xs-13', 'xs-strong-13',
  's-14', 's-strong-14', 'base-16', 'base-strong-16', 'm-18', 'l-20', 'xl-24'])
const steps = [...source.matchAll(/--dsw-font-([a-z0-9-]+)\)/g)].map((m) => m[1])
const offRamp = steps.filter((s) => s !== 'family' && !RAMP.has(s))
assert(steps.length > 0 && offRamp.length === 0,
  'every font token used is a published step' + (offRamp.length ? ': ' + offRamp.join(', ') : ''))

console.log('dictionaries')
// The dictionaries are module-private, so their keys are read off the source.
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
