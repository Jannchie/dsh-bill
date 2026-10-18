/**
 * The display currency is one stored preference, and it is not the budget's.
 *
 * Two promises are checked here, both of which the UI depends on:
 *
 *  - Choosing a currency writes it to `$DSH_HOME/dsh-bill/prefs.json`, so it
 *    survives a reload. This used to be component-local state in the report
 *    tab and a hard-coded `'CNY'` on the other two surfaces.
 *  - Setting a display currency does not move the budget's currency. A limit is
 *    a promise made in one currency ("¥100 a month"); restating it because the
 *    display changed would silently change what was promised.
 *
 * Run: node tests/prefs.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-prefs-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** The same minimal cordis stub the other tests use. */
function boot() {
  const instance = {}
  const services = { webServer: { register: (r) => { instance.api = r.handler } } }
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, {})
  return instance
}

const { api } = boot()
async function ask(body) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await new Promise((resolve) => {
    api(req, { writeHead() {}, end(text) { out = JSON.parse(text); resolve() } })
  })
  return out
}

const prefsFile = path.join(HOME, 'dsh-bill', 'prefs.json')
await new Promise((r) => setTimeout(r, 200))

console.log('the default is CNY')
const initial = await ask({ action: 'prefs' })
assert(initial.ok && initial.prefs.currency === 'CNY', 'currency defaults to CNY (got ' + initial.prefs.currency + ')')

console.log('choosing a currency stores it')
const set = await ask({ action: 'prefs-set', patch: { currency: 'EUR' } })
assert(set.ok && set.prefs.currency === 'EUR', 'the write is acknowledged with the new value')
const reread = await ask({ action: 'prefs' })
assert(reread.prefs.currency === 'EUR', 'the next read agrees (got ' + reread.prefs.currency + ')')

console.log('and lands on disk')
let onDisk = null
for (let i = 0; i < 40 && onDisk?.currency !== 'EUR'; i++) {
  await new Promise((r) => setTimeout(r, 50))
  try { onDisk = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) } catch { onDisk = null }
}
assert(onDisk && onDisk.currency === 'EUR',
  'prefs.json holds currency=EUR (' + (fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile, 'utf8').replace(/\s+/g, ' ') : 'no file') + ')')

console.log('the budget keeps its own currency')
const budget = await ask({ action: 'prefs-set', patch: { budgetAmount: 25, budgetCurrency: 'CNY' } })
assert(budget.prefs.budgetCurrency === 'CNY', 'the budget stayed in CNY')
assert(budget.prefs.currency === 'EUR', 'while the display stayed in EUR (got ' + budget.prefs.currency + ')')
const swapped = await ask({ action: 'prefs-set', patch: { currency: 'JPY' } })
assert(swapped.prefs.budgetCurrency === 'CNY', 'changing the display does not restate the budget (got ' + swapped.prefs.budgetCurrency + ')')

console.log('a stored document is coerced, not trusted')
const junk = await ask({ action: 'prefs-set', patch: { currency: '' } })
assert(junk.prefs.currency === 'CNY', 'an empty currency falls back to CNY (got ' + JSON.stringify(junk.prefs.currency) + ')')

console.log('the sidebar panel icon is a surface like the others')
assert(initial.prefs.showPanellist === true, 'shown by default (got ' + initial.prefs.showPanellist + ')')
const hidden = await ask({ action: 'prefs-set', patch: { showPanellist: false } })
assert(hidden.prefs.showPanellist === false, 'can be turned off')
assert(hidden.prefs.showSidebar === true, 'without touching the sidebar spend')

fs.rmSync(HOME, { recursive: true, force: true })

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
