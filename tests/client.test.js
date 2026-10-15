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
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

console.log('module evaluates')
let exported = null
const react = { sets: [], runEffect: () => {} }
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
        // Initialisers run and setters are recorded, so a component can be
        // called as a plain function below and its effects observed. Effects
        // go through `react.runEffect`, inert until a test wants them.
        useState: (init) => [typeof init === 'function' ? init() : init, (v) => react.sets.push(v)],
        useEffect: (fn) => react.runEffect(fn),
        useLayoutEffect: (fn) => react.runEffect(fn),
        useRef: (init) => ({ current: init }),
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
      }))
    },
  },
}
// A bare Windows path ('E:\...') is not a URL the ESM loader accepts.
await import(pathToFileURL(clientPath).href)
assert(exported !== null, 'the module loader factory ran')
assert(typeof exported.apply === 'function', 'exports apply()')
assert(Array.isArray(exported.inject) && exported.inject.includes('slots'), 'injects the slots service')
// `locale` must be a DECLARED dependency, not an optional `ctx.get()` lookup.
// Reading it without declaring it made the language a race between two halves
// of the client bundle: lose it and `translate` stays on `fallbackT` (the
// Chinese dictionary) while `localized()` omits `locale: NS`, so the tab, the
// settings nav, the dock and the turn rows all render Chinese under an English
// UI. Declaring it parks this half until the language service exists.
//
// `connection` and `layout` are read the same way and deliberately stay
// undeclared: each has an acceptable degraded path (RPC falls back to
// `/dsh-bill/api`; `layout` is only touched at click time), whereas a missing
// locale has no correct fallback — Chinese is not a fallback for English.
assert(exported.inject.includes('locale'), 'injects the locale service (the dictionaries are not optional)')

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
  'sidebar.session.row.hover',
  'sidebar.panellist',
  'main',
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
// DSH 0.1.7 re-declared the turn tail as a LIST: `id` required, `select`
// rejected. Registering the chain shape there throws and fails the whole
// client bundle, so the shape must follow the declared spec.
{
  const listed = []
  exported.apply({
    get: (name) => (name === 'slots'
      ? {
          inject: (key, effect) => effect(),
          register: (options) => { listed.push(options); return () => {} },
          spec: () => ({ kind: 'list' }),
        }
      : undefined),
    effect: () => {},
  })
  const tail = listed.find((o) => o.name === 'conversation.chat.turnTail')
  assert(typeof tail?.id === 'string' && tail.id.length > 0, 'a list-kind turn tail registers with an id')
  assert(tail?.select === undefined, 'a list-kind turn tail carries no chain selector')
}
// List seats need a stable id; two entries sharing one id at the same priority
// is a registration error, not a shadowing.
for (const key of ['conversation.view', 'settings.section', 'sidebar.footer.action', 'conversation.composer.dock', 'sidebar.session.row.hover', 'sidebar.panellist']) {
  assert(typeof seatOf(key).id === 'string' && seatOf(key).id.length > 0, key + ' declares an id')
}
// The global panel is a keyed main entry, addressed by the icon's id.
assert(seatOf('main')?.key === 'bill' && seatOf('sidebar.panellist')?.id === 'bill', 'the global panel and its sidebar icon share the id bill')
// Labels are thunks so a language switch re-reads them without re-registering.
assert(typeof seatOf('conversation.view').label === 'function', 'the view tab label is a thunk')
assert(typeof seatOf('settings.section').label === 'function', 'the settings nav label is a thunk')

console.log('host transport')
// The client being handed `connection.rpc` does not prove the host mounted
// the `/dsh-bill` channel: on DSH 0.1.5 `rpc.handle` throws for every plugin,
// so the channel object exists, the route does not, and every call comes back
// `transport failure ... HTTP 405` while `POST /dsh-bill/api` answers fine
// (issue #1). The transport is module-private, so it is driven the way the
// page drives it — through the dock component's effects.
const calls = []
const payloads = []
let rpcMode = 'transport'
const rpc = {
  call: (channel, endpoint, payload) => {
    calls.push('rpc:' + endpoint)
    payloads.push(payload)
    if (rpcMode === 'transport') return Promise.reject(new Error('transport failure for ' + channel + '/' + endpoint + ': HTTP 405'))
    if (rpcMode === 'handler') return Promise.resolve({ ok: false, error: { message: 'handler said no' } })
    return Promise.resolve({ ok: true, value: { via: 'rpc' } })
  },
}
let httpUp = true
globalThis.fetch = (url, init) => {
  calls.push('http:' + JSON.parse(init.body).action)
  if (!httpUp) return Promise.reject(new TypeError('Failed to fetch'))
  return Promise.resolve({ json: () => Promise.resolve({ via: 'http' }) })
}
// apply() is what resolves the channel, so re-running it hands the page a
// fresh one — the same shape as a reload against a host that has it.
const components = {}
function applyWithChannel() {
  exported.apply({
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (key, effect) => effect(),
          register: (options, component) => { components[options.name] = component; return () => {} },
        }
      }
      if (name === 'connection') return { rpc }
      return undefined
    },
    effect: () => {},
  })
}
// Render the dock once: effects run, the calls settle, then the effects are
// torn down (which also clears the slow poll timer). Returns the settled
// states the component set.
async function renderDock() {
  const cleanups = []
  react.runEffect = (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) }
  react.sets = []
  components['conversation.composer.dock']({ sessionId: 's1' })
  await new Promise((r) => setTimeout(r, 0))
  cleanups.forEach((c) => c())
  react.runEffect = () => {}
  return react.sets
}
const answered = (sets) => sets.find((s) => s && s.loading === false)

applyWithChannel()
let sets = await renderDock()
assert(calls.includes('rpc:session-cost'), 'the channel is tried first')
assert(calls.indexOf('http:session-cost') > calls.indexOf('rpc:session-cost'), 'a transport failure falls back to POST /dsh-bill/api')
assert(answered(sets)?.data?.via === 'http', 'the HTTP answer is the one shown, not the 405')

calls.length = 0
sets = await renderDock()
assert(!calls.some((c) => c.startsWith('rpc:')), 'after a successful fallback the dead channel is not tried again')
assert(answered(sets)?.data?.via === 'http', 'HTTP keeps serving')

calls.length = 0
rpcMode = 'handler'
applyWithChannel()
sets = await renderDock()
assert(calls.includes('rpc:session-cost') && !calls.includes('http:session-cost'), 'a handler error is an answer, not a transport failure: no fallback')
assert(answered(sets)?.error === 'handler said no', 'the handler\'s message is what surfaces')

calls.length = 0
rpcMode = 'ok'
applyWithChannel()
sets = await renderDock()
assert(answered(sets)?.data?.via === 'rpc' && !calls.includes('http:session-cost'), 'a working channel is used as before')

calls.length = 0
rpcMode = 'transport'
httpUp = false
applyWithChannel()
sets = await renderDock()
assert(/transport failure .*HTTP 405/.test(answered(sets)?.error ?? ''), 'with both carriers down, the transport error is the one reported')
calls.length = 0
sets = await renderDock()
assert(calls.includes('rpc:session-cost'), 'a fallback that also failed does not demote the channel')
httpUp = true

console.log('session hover card')
// The hover card mounts one entry per open card, so it must ask for that one
// session's fold — not the overview, which also totals every session.
calls.length = 0
payloads.length = 0
rpcMode = 'ok'
applyWithChannel()
{
  const cleanups = []
  react.runEffect = (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) }
  components['sidebar.session.row.hover']({ sessionId: 's9' })
  await new Promise((r) => setTimeout(r, 0))
  cleanups.forEach((c) => c())
  react.runEffect = () => {}
}
assert(calls.length === 1 && calls[0] === 'rpc:session-cost', 'the hover card makes one session-cost call (got ' + calls.join(', ') + ')')
assert(payloads[0]?.sessionId === 's9', 'the call is scoped to the hovered session')

console.log('account-wide spend, long-polled')
// Every surface showing today / month / all time shares one loop per window,
// and the loop hands back the rev it holds so the host can sit on the request
// until spend moves. Driven through the sidebar line, mounted twice.
{
  const held = []
  const periodCalls = () => payloads.filter((p) => p && p.action === 'periods')
  const originalCall = rpc.call
  rpc.call = (channel, endpoint, payload) => {
    calls.push('rpc:' + endpoint)
    payloads.push(payload)
    if (endpoint !== 'periods') return Promise.resolve({ ok: true, value: {} })
    return new Promise((resolve) => held.push((value) => resolve({ ok: true, value })))
  }
  calls.length = 0
  payloads.length = 0
  applyWithChannel()
  const cleanups = []
  const states = []
  react.runEffect = (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) }
  react.sets = []
  components['sidebar.footer.action']({})
  components['sidebar.footer.action']({})
  await new Promise((r) => setTimeout(r, 0))
  assert(periodCalls().length === 1, 'two surfaces share one request (got ' + periodCalls().length + ')')
  assert(periodCalls()[0].sinceRev === undefined, 'the first asks for the figures as they stand')

  held.shift()({ rev: 'r1', periods: { day: 1, month: 1, all: 1 }, fx: { USD: 1 } })
  await new Promise((r) => setTimeout(r, 0))
  assert(react.sets.some((v) => v && v.data && v.data.periods && v.data.periods.day === 1), 'the answer reaches the surfaces')
  assert(periodCalls().length === 2, 'the next request goes out at once')
  assert(periodCalls()[1].sinceRev === 'r1' && periodCalls()[1].waitMs === 25000, 'carrying the rev it holds, to be held until spend moves')

  const before = react.sets.length
  held.shift()({ rev: 'r1', periods: { day: 1, month: 1, all: 1 }, fx: { USD: 1 } })
  await new Promise((r) => setTimeout(r, 0))
  assert(react.sets.length === before, 'a wait that ran out with nothing new re-renders nothing')

  held.shift()({ rev: 'r2', periods: { day: 2, month: 2, all: 2 }, fx: { USD: 1 } })
  await new Promise((r) => setTimeout(r, 0))
  assert(react.sets.some((v) => v && v.data && v.data.periods && v.data.periods.day === 2), 'moved spend is shown')
  assert(periodCalls().at(-1).sinceRev === 'r2', 'and the loop follows the new rev')

  console.log('an older host, without a rev')
  held.shift()({ periods: { day: 3, month: 3, all: 3 }, fx: { USD: 1 } })
  await new Promise((r) => setTimeout(r, 50))
  const afterOld = periodCalls().length
  assert(held.length === 0, 'is not asked again at once: no rev means the three-second cadence, not a spin')

  cleanups.forEach((c) => c())
  react.runEffect = () => {}
  await new Promise((r) => setTimeout(r, 0))
  assert(periodCalls().length === afterOld, 'once nothing shows the figures, the loop stops')
  rpc.call = originalCall
}
delete globalThis.fetch

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

console.log('range windows')
// Rolling and calendar windows answer different questions, so the menu must
// offer both, and the shortest rolling window must be named in hours: a rolling
// day slides with the clock, and calling it "the last day" is exactly the
// ambiguity the second group exists to remove. Read off the source because the
// stub React above discards the element tree and the menu rows are data.
const rangesTable = /var RANGES = \[([\s\S]*?)\n    \]/.exec(source)
assert(rangesTable !== null, 'the windows are declared as one table')
if (rangesTable) {
  const rows = [...rangesTable[1].matchAll(/\{\s*id: '([^']+)',\s*group: '([^']+)',([^}]*)\}/g)]
    .map((m) => ({ id: m[1], group: m[2], rest: m[3] }))
  const ids = rows.map((r) => r.id)
  assert(ids.length >= 6, 'the table lists the windows: ' + ids.join(', '))
  assert(new Set(ids).size === ids.length, 'every window has its own id')
  assert(rows.filter((r) => r.group === 'day').map((r) => r.id).join(',') === 'today,yesterday',
    'the calendar group offers today and yesterday')
  const rolling = rows.filter((r) => r.group === 'rolling')
  assert(rolling.length > 0, 'rolling windows are offered')
  // Every rolling window carries its length in days, because that is what the
  // figures dividing by the window read. The 24-hour row is the one that also
  // carries hours — how it is named, and what its hint quotes.
  assert(rolling.every((r) => /days: [1-9]/.test(r.rest)),
    'every rolling window declares a positive day count: ' + rolling.map((r) => r.id + '(' + r.rest.trim() + ')').join(', '))
  assert(rolling.some((r) => /hours: 24/.test(r.rest)), 'the shortest rolling window is named in hours')
  assert(rows.some((r) => r.group === 'all'), 'all time is still offered')
}
// A calendar window asks by name and a rolling one by count: sending the wrong
// field would answer the other question without saying so.
assert(/day: range\.day/.test(source) && /rangeDays: range\.days/.test(source),
  'a calendar window asks by day, a rolling one by count')
// The 24-hour window is the one row whose name is not a day count, so the name
// has to be read before the all-time fallback no day count would take. The bug
// this pins is real: without it the row renders as "All time" and asks for the
// default window instead of its own.
const labelBody = /function rangeLabel\(t, range\) \{([\s\S]*?)\n    \}/.exec(source)
assert(labelBody !== null, 'rangeLabel is the one place a window is named')
if (labelBody) {
  const hours = labelBody[1].indexOf('range.hours')
  const allTime = labelBody[1].indexOf("t('range.all')")
  assert(hours >= 0 && allTime >= 0 && hours < allTime,
    'hours are read before the all-time fallback a dayless window would take')
}
// A session's tab has no window and no forecast, so its total carries no hint:
// the fallback "rate" there is the total divided by one, said twice.
assert(/hint: sessionScope \? '' : totalHint/.test(source), 'a session total carries no window hint')
// A window under a week has no rate worth extrapolating a month from.
assert(/forecastable && fc && fc\.per30dUsd > 0/.test(source), 'the monthly estimate is gated on a long enough window')
// A day or less is drawn from the hourly series the host already sends.
assert(/hourly \? bucketHours\(d\.timelineHours/.test(source), 'a day or less is charted by the hour')
// `type: 'label'` and `type: 'separator'` are the shipped Menu's grouping rows.
assert(/type: 'label'/.test(source) && /type: 'separator'/.test(source),
  'the menu groups its rows the way the shipped Menu expects')

console.log('timeline helpers')
// The chart's arithmetic is module-private and pure, so it is lifted out of the
// source and run here: the stub React discards the element tree, but bucketing,
// stacking and scale are numbers, and numbers can be checked.
const chartBlock = /\n    var SERIES_COLORS = [\s\S]*?\n(?=    \/\*\* The timeline's heading)/.exec(source)
assert(chartBlock !== null, 'the chart helpers are one block')
if (chartBlock) {
  const lib = new Function('monthDay', 'modelLabel', chartBlock[0]
    + '\nreturn { modelPalette, segmentsOf, granOf, bucketDays, bucketTitle, niceCeil }')(
    (day) => String(day).slice(5), (row) => row.displayName || row.model)
  const t = (key) => key

  // Granularity follows the number of days, so a year is months, not slivers.
  assert(lib.granOf(30) === 'day' && lib.granOf(90) === 'week' && lib.granOf(365) === 'month',
    'a month is days, a quarter weeks, a year months')

  // Weeks start on Monday and partial weeks sum only the days they hold.
  // 2026-09-27 is a Sunday; 09-28 opens the next week.
  const days = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'].map((day, i) =>
    ({ day, usd: i + 1, calls: 1, models: { 'p/a': i + 1 } }))
  const weeks = lib.bucketDays(days, 'week')
  assert(weeks.length === 2 && weeks[0].key === '2026-09-21' && weeks[1].key === '2026-09-28',
    'weeks are keyed by their Monday (got ' + weeks.map((w) => w.key).join(',') + ')')
  assert(weeks[0].usd === 3 && weeks[1].usd === 7 && weeks[1].models['p/a'] === 7,
    'a week sums its days and their split')
  assert(lib.bucketTitle(weeks[0], 'week') === '2026-09-26 – 09-27',
    'a partial week is titled by the days it holds')
  const months = lib.bucketDays(days, 'month')
  assert(months.length === 1 && months[0].key === '2026-09' && months[0].calls === 4, 'months group by YYYY-MM')

  // Colour follows the model: seven slots and grey "other" once there are nine.
  const nine = Array.from({ length: 9 }, (_, i) => ({ provider: 'p', model: 'm' + i, usd: 9 - i }))
  const pal = lib.modelPalette(nine, t)
  assert(pal.slotted('p/m0') && pal.slotted('p/m6') && !pal.slotted('p/m7') && !pal.slotted('p/m8'),
    'nine models keep seven colours and fold the rest')
  assert(pal.colorOf('p/m0') !== pal.colorOf('p/m1'), 'slotted models get their own colours')
  const eight = lib.modelPalette(nine.slice(0, 8), t)
  assert(eight.slotted('p/m7'), 'exactly eight models all keep a colour')

  // Segments: slotted models bottom up, the rest as other, the unsplit
  // remainder of an archived day as archived — and rounding is not archived.
  const segs = lib.segmentsOf({ usd: 10, models: { 'p/m0': 4, 'p/m8': 1 } }, pal)
  assert(segs.map((x) => x.key + '=' + x.usd).join(',') === 'p/m0=4,other=1,archived=5',
    'a bar splits into models, other, and archived (got ' + segs.map((x) => x.key + '=' + x.usd).join(',') + ')')
  const rounded = lib.segmentsOf({ usd: 1.0000004, models: { 'p/m0': 1 } }, pal)
  assert(rounded.length === 1, 'a rounding remainder is not drawn as archived')

  // The scale tops out at a figure a person would write down.
  assert(lib.niceCeil(0.73) === 0.8 && lib.niceCeil(1.3) === 1.5 && lib.niceCeil(10.4) === 15
    && lib.niceCeil(41) === 50 && lib.niceCeil(0) === 1, 'the scale rounds up to a round step × 10ⁿ')
}

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
  // A window measured in hours needs its own wording in both dictionaries —
  // English would otherwise read "24 days" — and a key the code names but the
  // dictionary lacks renders as its own name, so presence is worth asserting.
  for (const key of ['kpi.totalHint.hours', 'kpi.forecastHint.b.one']) {
    assert(zh.has(key) && en.has(key), 'both dictionaries carry ' + key)
  }
  // A key the source names but neither dictionary carries renders as its own
  // name — "1kpi.totalHint.one · ¥1.91" in the report — and a key renamed on
  // one side only is the easy mistake. Read off the keys of every `t(...)`
  // call whose argument is literal; a ternary picks one of two, so both are
  // read. An argument built by concatenation ('surfaces.' + key) is not a key
  // and is skipped — the parity check above already covers its parts.
  const named = new Set()
  for (const call of source.matchAll(/\bt\(([^)]*)\)/g)) {
    if (call[1].includes('+')) continue
    for (const literal of call[1].matchAll(/'([^']+)'/g)) named.add(literal[1])
  }
  const unknown = [...named].filter((k) => !zh.has(k) || !en.has(k))
  assert(named.size > 30, 'the source names ' + named.size + ' literal keys')
  assert(unknown.length === 0, 'every key the source names is translated in both dictionaries'
    + (unknown.length ? ': ' + unknown.join(', ') : ''))
}

console.log('dictionary values are literals')
// A global find-and-replace over UI strings once rewrote the dictionary's own
// values into `t(...)` calls, which throws at module scope. Values must be
// plain strings.
const dictBodies = source.slice(source.indexOf('var DICT_ZH'), source.indexOf('function fallbackT'))
assert(!/':\s*t\(/.test(dictBodies), 'no dictionary value calls t()')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
