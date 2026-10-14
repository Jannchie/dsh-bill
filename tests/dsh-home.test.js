/**
 * `dshHome` puts one instance's store in its own harness home.
 *
 * `$DSH_HOME` belongs to the process, and one process can host several harness
 * instances (one per user, say). The harness's own stores take a `dshHome`
 * config for that, ahead of `$DSH_HOME`; this checks dsh-bill honours the same
 * option the same way:
 *
 *  - two instances in one process, each with its own `dshHome`, keep their
 *    preferences apart, and neither writes under `$DSH_HOME`;
 *  - the schema accepts a path and refuses a blank or non-string one;
 *  - a configured path is spelled as the harness spells it (`~` is the OS home,
 *    a relative path is resolved), and without one `$DSH_HOME` still applies.
 *
 * Run: node tests/dsh-home.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(os.tmpdir(), 'dsh-bill-dsh-home-test')
fs.rmSync(ROOT, { recursive: true, force: true })
const SHARED = path.join(ROOT, 'process-home')
const ALICE = path.join(ROOT, 'alice')
const BOB = path.join(ROOT, 'bob')
process.env.DSH_HOME = SHARED

const { default: plugin, Config } = await import('../lib/index.js')
const { resolveDshHome } = await import('../lib/hostkit.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** The same minimal cordis stub the other tests use, with a config. */
function boot(config) {
  const instance = {}
  const services = { webServer: { register: (r) => { instance.api = r.handler } } }
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, config)
  return async (body) => {
    const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
    let out = null
    await new Promise((resolve) => {
      instance.api(req, { writeHead() {}, end(text) { out = JSON.parse(text); resolve() } })
    })
    return out
  }
}

/** A JSON file once it holds `want`, or whatever it holds after ~2s. */
async function settled(file, want) {
  let doc = null
  for (let i = 0; i < 40; i++) {
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { doc = null }
    if (doc && Object.entries(want).every(([k, v]) => doc[k] === v)) break
    await new Promise((r) => setTimeout(r, 50))
  }
  return doc
}

console.log('two instances in one process keep their own stores')
const alice = boot({ dshHome: ALICE })
const bob = boot({ dshHome: BOB })
await new Promise((r) => setTimeout(r, 200))
await alice({ action: 'prefs-set', patch: { currency: 'EUR' } })
await bob({ action: 'prefs-set', patch: { currency: 'JPY' } })
const alicePrefs = await settled(path.join(ALICE, 'dsh-bill', 'prefs.json'), { currency: 'EUR' })
const bobPrefs = await settled(path.join(BOB, 'dsh-bill', 'prefs.json'), { currency: 'JPY' })
assert(alicePrefs?.currency === 'EUR', "alice's prefs.json is under her dshHome (got " + JSON.stringify(alicePrefs?.currency) + ')')
assert(bobPrefs?.currency === 'JPY', "bob's prefs.json is under his dshHome (got " + JSON.stringify(bobPrefs?.currency) + ')')
assert((await alice({ action: 'prefs' })).prefs.currency === 'EUR', "bob's write did not reach alice's instance")
assert(!fs.existsSync(path.join(SHARED, 'dsh-bill')), 'nothing was written under $DSH_HOME')

console.log('the schema takes a path')
const validate = (input) => Config['~standard'].validate(input)
assert(validate({ dshHome: ALICE }).value?.dshHome === ALICE, 'a path is kept as given')
assert(!('dshHome' in validate({}).value), 'absent stays absent, so $DSH_HOME applies')
for (const bad of ['', '   ', 42, null]) {
  const r = validate({ dshHome: bad })
  assert(r.issues?.some((i) => i.path?.[0] === 'dshHome'), 'refuses ' + JSON.stringify(bad) + ' by name')
}

console.log('a configured path is spelled as the harness spells it')
assert(resolveDshHome(ALICE) === ALICE, 'an absolute path is used as is')
assert(resolveDshHome('~') === os.homedir(), '~ is the OS home')
assert(resolveDshHome('~/.dsh-alice') === path.join(os.homedir(), '.dsh-alice'), '~/ is under the OS home')
assert(resolveDshHome('homes/alice') === path.resolve('homes/alice'), 'a relative path is resolved against the cwd')
assert(resolveDshHome() === SHARED, 'without one, $DSH_HOME applies')
process.env.DSH_HOME = '  '
assert(resolveDshHome() === path.join(os.homedir(), '.dsh'), 'and a blank $DSH_HOME falls back to ~/.dsh')

fs.rmSync(ROOT, { recursive: true, force: true })

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
