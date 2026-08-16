/**
 * The per-turn projection must not double-count, must not lose turns, and must
 * refuse config that would silently produce an empty report.
 *
 * The fold is where a wrong number is invisible: a step reports usage twice by
 * design, so an implementation that simply adds every sample looks right on a
 * hand-written log and doubles the real bill on a real one.
 *
 * Run: node tests/projection.test.js
 */
import plugin, { Config } from '../lib/index.js'
import { billTurnsProjection as unit } from '../lib/projection.js'

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

let seq = 0
const event = (type, data, time = 1_770_000_000_000) => ({ type, seq: seq++, time, data })
const usage = (input, output, read = 0, write = 0) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
})
const fold = (events) => events.reduce((state, ev) => unit.apply(state, ev), unit.init())

const HEADER = event('request/header', {
  header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } },
  reason: 'initial',
})

console.log('a step that reports usage twice is counted once')
// The live stream emits a usage chunk, then the finalized message repeats it.
const doubled = fold([
  HEADER,
  event('turn/start', { turn: 0 }),
  event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: usage(1000, 200) } }),
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 200) }),
])
assert(doubled.totals.calls === 1, 'one call, not two (got ' + doubled.totals.calls + ')')
assert(doubled.totals.inputTokens === 1000, 'input counted once (got ' + doubled.totals.inputTokens + ')')
assert(doubled.turns.length === 1 && doubled.turns[0].inputTokens === 1000, 'the turn row is not doubled')

console.log('a corrected repeat replaces the earlier sample')
// The chunk reports what had streamed so far; the message reports the truth.
const corrected = fold([
  HEADER,
  event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: usage(1000, 120) } }),
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 340) }),
])
assert(corrected.totals.outputTokens === 340, 'the later report wins (got ' + corrected.totals.outputTokens + ')')

console.log('steps accumulate within a turn, turns stay apart')
const multi = fold([
  HEADER,
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 100) }),
  event('assistant/message', { turn: 0, step: 1, message: {}, usage: usage(2000, 200) }),
  event('assistant/message', { turn: 1, step: 0, message: {}, usage: usage(500, 50) }),
])
assert(multi.turns.length === 2, 'two turn rows (got ' + multi.turns.length + ')')
assert(multi.turns[0].inputTokens === 3000, 'turn 0 sums its two steps (got ' + multi.turns[0].inputTokens + ')')
assert(multi.turns[0].calls === 2, 'turn 0 counts two calls (got ' + multi.turns[0].calls + ')')
assert(multi.turns[1].inputTokens === 500, 'turn 1 is untouched by turn 0')
assert(multi.totals.calls === 3, 'three calls in total (got ' + multi.totals.calls + ')')

console.log('an uninteresting event returns the same state reference')
// The framework treats an unchanged reference as "nothing to do" — this is
// what keeps the unit free on the chunks that make up most of a log.
const before = multi
const after = unit.apply(before, event('assistant/chunk', {
  turn: 1, step: 0, chunk: { type: 'text-delta', text: 'hello' },
}))
assert(after === before, 'a text chunk changes nothing')
assert(unit.apply(before, event('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' })) === before,
  'a tool call changes nothing')

console.log('the route comes from the header, and the message overrides it')
assert(multi.turns[0].model === 'deepseek-chat', 'header model reached the row')
const rerouted = unit.apply(multi, event('assistant/message', {
  turn: 2, step: 0, message: { source: { provider: 'openai', model: 'gpt-5' } }, usage: usage(10, 10),
}))
assert(rerouted.turns[2].model === 'gpt-5', 'the message names its own route (got ' + rerouted.turns[2].model + ')')

console.log('the view is a whole value the wire accepts')
const value = unit.schema.parse(unit.view(multi))
assert(value.calls === 3, 'view carries the call count')
assert(value.turns.length === 2, 'view carries the turn rows')
assert(typeof value.totalUsd === 'number', 'view carries a total')
// A row either carries a price or reports null — never a confident 0 for a
// model no catalogue lists. deepseek-chat is a built-in override, so it prices
// without any catalogue fetch.
assert(value.turns.every((row) => row.usd === null || typeof row.usd === 'number'), 'each row prices or reports null')
assert(value.priced === true && value.totalUsd > 0, 'a known model prices (got ' + value.totalUsd + ')')

console.log('an unknown model reports unpriced rather than free')
const unknown = fold([
  event('request/header', { header: { config: { provider: 'x', model: 'no-such-model-xyz' } }, reason: 'initial' }),
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 100) }),
])
const unknownView = unit.view(unknown)
assert(unknownView.turns[0].usd === null, 'the row is null, not 0')
assert(unknownView.priced === false, 'the whole value is flagged unpriced')

console.log('repricing is cached on row identity')
// view() runs on every read AND every change, and apply() replaces exactly one
// row per event. Without a cache a 400-turn session reprices 400 rows twice per
// step; the cache is what makes the reused rows free, so its absence is a
// silent performance cliff no other assertion would catch.
const first = unit.view(multi)
const second = unit.view(multi)
assert(first.turns[0] === second.turns[0], 'an unchanged row is the same object across reads')
const grown = unit.apply(multi, event('assistant/message', { turn: 5, step: 0, message: {}, usage: usage(10, 10) }))
const after2 = unit.view(grown)
assert(after2.turns[0] === first.turns[0], 'a change to one turn does not reprice the others')
assert(after2.turns[after2.turns.length - 1] !== first.turns[first.turns.length - 1], 'the changed turn is rebuilt')

console.log('the empty log is a valid value')
const empty = unit.schema.parse(unit.view(unit.init()))
assert(empty.calls === 0 && empty.turns.length === 0, 'empty log yields empty totals')

console.log('config is validated before the fiber starts')
const validate = (input) => Config['~standard'].validate(input)
assert(validate(undefined).value.maxRecords > 0, 'a config-less row gets the default cap')
assert(validate({}).value.maxRecords > 0, 'an empty config gets the default cap')
assert(validate({ maxRecords: 50 }).value.maxRecords === 50, 'an explicit cap passes through')
assert(validate({ maxRecords: 0 }).issues?.[0]?.path?.[0] === 'maxRecords', 'a zero cap is refused, naming the field')
assert(validate({ maxRecords: 'lots' }).issues !== undefined, 'a non-numeric cap is refused')
assert(validate({ priceOverrides: { 'my-model': { inputPerM: 1, outputPerM: 2 } } }).issues === undefined,
  'a complete price override passes')
const halfPrice = validate({ priceOverrides: { 'my-model': { inputPerM: 1 } } })
assert(halfPrice.issues?.some((i) => i.path?.join('.') === 'priceOverrides.my-model.outputPerM'),
  'a half-specified override is refused at its exact path')

console.log('the plugin declares no hard dependency')
assert(Array.isArray(plugin.inject) && plugin.inject.length === 0,
  'inject is empty, so a carrier-less assembly still records (got ' + JSON.stringify(plugin.inject) + ')')
assert(plugin.Config === Config, 'the plugin exposes its schema to the loader')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
