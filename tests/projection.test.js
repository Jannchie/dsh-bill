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
import { billLiveProjection as live, billTurnsProjection as unit } from '../lib/projection.js'

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
const foldLive = (events) => events.reduce((state, ev) => live.apply(state, ev), live.init())
/** One text fragment per entry, streamed for one attempt. */
const stream = (turn, step, texts) => texts.map((text) =>
  event('assistant/chunk', { turn, step, chunk: { type: 'text-delta', text } }))

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

console.log('the unit carries the DSH 0.1.7 registry shape too')
// 0.1.7 pushes a value to the browser only for a unit with `wire`, and parses
// a checkpointed row through `stateSchema` before resuming from it. Missing
// either, the per-turn line silently never renders.
assert(unit.wire?.viewSchema.parse(unit.wire.view(multi)).calls === 3, 'wire.view is the same whole value')
const roundTripped = JSON.parse(JSON.stringify(multi))
assert(unit.stateSchema.parse(roundTripped) === roundTripped, 'a checkpointed state parses back')
let rejected = false
try { unit.stateSchema.parse({ turns: 'nope' }) } catch { rejected = true }
assert(rejected, 'a malformed checkpoint is refused, so the host refolds from init')

console.log('an unknown model reports unpriced rather than free')
const unknown = fold([
  event('request/header', { header: { config: { provider: 'x', model: 'no-such-model-xyz' } }, reason: 'initial' }),
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 100) }),
])
const unknownView = unit.view(unknown)
assert(unknownView.turns[0].usd === null, 'the row is null, not 0')
assert(unknownView.priced === false, 'the whole value is flagged unpriced')

console.log('the open step is estimated from what has actually streamed')
// 100 characters of output, published at the 64-character quantum and priced
// at the harness's own four-characters-per-token density.
const openEvents = [
  HEADER,
  event('step/start', { turn: 0, step: 0 }),
  ...stream(0, 0, ['x'.repeat(100)]),
]
const open = foldLive(openEvents)
const estimate = live.wire.viewSchema.parse(live.view(open))
assert(estimate !== null && estimate.turn === 0 && estimate.step === 0, 'the estimate names its attempt')
assert(estimate.outputTokens === 16, 'published characters over four (got ' + estimate.outputTokens + ')')
// The same output tokens through the exact path cost the same, because both go
// through `priceRecord` at the same instant — so peak/off-peak and the
// catalogue cannot make the estimate and the bill disagree.
const sameTokens = unit.view(fold([
  HEADER,
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(0, 16) }),
]))
assert(estimate.usd > 0 && Math.abs(estimate.usd - sameTokens.totalUsd) <= Math.abs(estimate.usd) * 1e-9,
  'the estimate prices like a settled call of the same output (got ' + estimate.usd + ' vs ' + sameTokens.totalUsd + ')')

console.log('the estimate is replaced by the settled figure, never added to it')
// A turn whose stream was observed and one whose stream was not must bill the
// same: the estimate is a view of work in progress, not a second ledger.
const settledEvents = [
  ...openEvents,
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 120) }),
]
const streamed = settledEvents.reduce((state, ev) => unit.apply(state, ev), unit.init())
const plain = fold([
  HEADER,
  event('assistant/message', { turn: 0, step: 0, message: {}, usage: usage(1000, 120) }),
])
assert(unit.view(streamed).totalUsd === unit.view(plain).totalUsd, 'the estimate never entered the total')
assert(unit.view(streamed).settled.turn === 0 && unit.view(streamed).settled.step === 0,
  'the value names the attempt whose usage landed')
assert(unit.view(plain).settled !== null && unit.view(plain).settled.step === 0, 'and it is derived from usage alone')
assert(unit.view(unit.init()).settled === null, 'an empty log has settled nothing')
assert(live.view(foldLive(settledEvents)) === null, 'the estimate is gone the moment the attempt settles')
assert(live.view(live.apply(foldLive(openEvents), event('step/end', { turn: 0, step: 0 }))) === null,
  'a step that ends without a message clears it too')

console.log('publication is quantized, so one fragment is not one frame')
const below = foldLive([HEADER, event('step/start', { turn: 0, step: 0 }), ...stream(0, 0, ['z'.repeat(63)])])
assert(live.view(below) === null, 'a fragment under the quantum publishes nothing')
const at = live.apply(below, stream(0, 0, ['z'])[0])
const published = live.view(at)
assert(published !== null && published.outputTokens === 16, 'crossing the quantum publishes the estimate')
assert(live.view(live.apply(at, stream(0, 0, ['z'])[0])) === published,
  'a fragment that does not cross the next quantum reuses the published value')

console.log('a retry estimates the new attempt, not both')
const retried = foldLive([
  HEADER,
  event('step/start', { turn: 0, step: 0 }),
  ...stream(0, 0, ['a'.repeat(200)]),
  event('llm/retry-started', { turn: 0, step: 0 }),
  ...stream(0, 0, ['b'.repeat(64)]),
])
assert(live.view(retried).outputTokens === 16,
  'only the surviving attempt is counted (got ' + live.view(retried).outputTokens + ')')

console.log('an unpriced model estimates nothing rather than zero')
const unpriced = foldLive([
  event('request/header', { header: { config: { provider: 'x', model: 'no-such-model-xyz' } } }),
  event('step/start', { turn: 0, step: 0 }),
  ...stream(0, 0, ['c'.repeat(200)]),
])
assert(live.view(unpriced).usd === null, 'the estimate is null, not 0')

console.log('non-output events leave the live unit alone')
const idle = foldLive([HEADER, event('step/start', { turn: 0, step: 0 })])
assert(live.apply(idle, event('tool/call', { turn: 0, step: 0, callId: 'c', name: 'bash', arguments: '{}' })) === idle,
  'a tool call is not streamed output')
assert(live.apply(idle, event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: usage(1, 1) } })) === idle,
  'a usage fragment is not streamed output')

console.log('the live unit carries the registry shape too')
assert(live.wire?.viewSchema.parse(null) === null, 'no attempt streaming is a valid value')
assert(live.wire.viewSchema.parse(live.view(at)).turn === 0, 'wire.view is the same value')
const closedLive = live.init()
assert(live.stateSchema.parse(closedLive) === closedLive, 'a closed checkpoint parses back as itself')
// A checkpoint outlives the process that watched the stream, so an attempt
// restored from one is cleared rather than served: an estimate nobody can
// settle must not reach the screen.
const restoredLive = live.stateSchema.parse(JSON.parse(JSON.stringify(at)))
assert(restoredLive.turn === null && restoredLive.chars === 0, 'a checkpointed attempt is cleared on restore')
assert(live.view(restoredLive) === null, 'and it serves no estimate')
let liveRejected = false
try { live.stateSchema.parse({ chars: 'nope' }) } catch { liveRejected = true }
assert(liveRejected, 'a malformed checkpoint is refused, so the host refolds from init')
let liveValueRejected = false
try { live.wire.viewSchema.parse({ turn: 0, step: 0, outputTokens: 16 }) } catch { liveValueRejected = true }
assert(liveValueRejected, 'a value missing its amount is refused')

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
assert(validate(undefined).value.agentTool === true, 'a config-less row registers the agent tool')
assert(validate({}).value.agentTool === true, 'an empty config registers the agent tool')
assert(validate({ agentTool: false }).value.agentTool === false, 'agentTool: false passes through')
assert(validate({ agentTool: 'no' }).issues?.[0]?.path?.[0] === 'agentTool', 'a non-boolean agentTool is refused, naming the field')
assert(validate({ priceOverrides: { 'my-model': { inputPerM: 1, outputPerM: 2 } } }).issues === undefined,
  'a complete price override passes')
const halfPrice = validate({ priceOverrides: { 'my-model': { inputPerM: 1 } } })
assert(halfPrice.issues?.some((i) => i.path?.join('.') === 'priceOverrides.my-model.outputPerM'),
  'a half-specified override is refused at its exact path')

assert(validate({ rateCurrency: 'USD' }).value.rateCurrency === 'USD', 'a currency code passes through')
assert(validate({ rateCurrency: ' usd ' }).value.rateCurrency === 'USD', 'a lower-case code is normalised')
assert(validate({}).value.rateCurrency === undefined, 'rateCurrency stays unset by default')
for (const bad of ['XYZ', 'US', 'dollars', 840]) {
  assert(validate({ rateCurrency: bad }).issues?.[0]?.path?.[0] === 'rateCurrency',
    'rateCurrency ' + JSON.stringify(bad) + ' is refused, naming the field')
}

console.log('the plugin declares no hard dependency')
assert(Array.isArray(plugin.inject) && plugin.inject.length === 0,
  'inject is empty, so a carrier-less assembly still records (got ' + JSON.stringify(plugin.inject) + ')')
assert(plugin.Config === Config, 'the plugin exposes its schema to the loader')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
