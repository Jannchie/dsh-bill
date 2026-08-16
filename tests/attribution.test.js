/**
 * Tests for content cost attribution.
 * Run: node tests/attribution.test.js
 */
import { DETAILS, attributeCost, normalizeTo, segmentsOf, shellProgram } from '../lib/attribution.js'
import { ratesFor } from '../lib/pricing.js'

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

/** A request shaped like a real agent turn. */
const options = {
  system: 'x'.repeat(1000),
  tools: [{ name: 'read', description: 'y'.repeat(200), parameters: {} }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'u'.repeat(50) }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>' + 'r'.repeat(100) }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 't'.repeat(300) },
        { type: 'text', text: 'a'.repeat(120) },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"/tmp/a"}' },
        { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"git diff --stat"}' },
        { type: 'tool-call', id: 'c3', name: 'edit', arguments: '{"old":"' + 'e'.repeat(400) + '"}' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'f'.repeat(5000) }] },
        { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'g'.repeat(800) }] },
        { type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'ok' }] },
        { type: 'image', attachment: { id: 'img1', bytes: 4096 } },
      ],
    },
  ],
}

console.log('segmentation')
const segments = segmentsOf(options)
const byCat = {}
for (const s of segments) byCat[s.cat] = (byCat[s.cat] ?? 0) + s.chars
assert(byCat.system === 1000 + JSON.stringify(options.tools).length, 'system prompt + tool schema counted')
assert(byCat.user === 50, 'only what the user actually typed lands in 我敲的字')
assert(byCat.scaffold === 117, 'system-reminder text is scaffolding, not typing')
assert(byCat['tool-read'] === 5000, 'read tool RESULT is the read-in content')
assert(byCat.terminal === '{"command":"git diff --stat"}'.length + 800, 'bash call + result group under 终端命令')
assert(segments.some((s) => s.cat === 'terminal' && s.sub === 'git'), 'terminal spend is grouped by program (git)')
assert(byCat.media > 0, 'image attachment is counted')
// edit call args (410ish) + its receipt ("ok")
assert(byCat['tool-write'] === '{"old":"' .length + 400 + 2 + 2, 'write tool args + receipt bill to the tool')
assert(byCat.model === 300 + 120 + '{"path":"/tmp/a"}'.length, 'assistant text/thinking/read-args are model output')

console.log('order is provider order (cache prefix depends on it)')
assert(segments[0].cat === 'system', 'system prompt is first')
assert(segments[segments.length - 1].cat === 'media', 'last user block is last')

console.log('shell program extraction')
assert(shellProgram('{"command":"git status"}') === 'git', 'plain command')
assert(shellProgram('{"command":"sudo rg foo"}') === 'rg', 'sudo skipped')
assert(shellProgram('{"command":"FOO=1 pnpm test"}') === 'pnpm', 'env prefix skipped')
assert(shellProgram('{"command":"/usr/bin/node x.js"}') === 'node', 'path stripped')
assert(shellProgram('not json') === null, 'unparseable command falls back to the tool name')

console.log('cost attribution')
const rates = ratesFor('deepseek-v4-pro', Date.UTC(2026, 7, 15))
const usage = { inputTokens: 2000, cacheReadTokens: 6000, cacheWriteTokens: 0, outputTokens: 500 }
const attr = attributeCost(segments, usage, { text: 900, reasoning: 300 }, rates)
const sum = Object.values(attr).reduce((a, b) => a + b, 0)
// The same numbers llm-pricing bills: fresh + cache read + output.
const expected = 2000 * rates.inputCostPerToken
  + 6000 * rates.cacheReadInputCostPerToken
  + 500 * rates.outputCostPerToken
assert(near(sum, expected, 1e-9), 'attribution sums to exactly the billed cost')
assert(attr['model|' + DETAILS.reply] > 0 && attr['model|' + DETAILS.thinking] > 0, 'output split into text vs thinking')
assert(near(attr['model|' + DETAILS.reply] / attr['model|' + DETAILS.thinking], 3, 1e-6), 'output split follows observed stream chars (900:300)')

console.log('cached prefix is charged at the cache rate, not an average')
// The system prompt sits at the very front, so it must be entirely inside the
// 6000-token cached prefix; the tail (the big tool result) pays full price.
const systemUsd = attr['system|' + DETAILS.systemPrompt]
const totalChars = segments.reduce((s, x) => s + x.chars, 0)
const systemTokens = 1000 / totalChars * 8000
assert(near(systemUsd, systemTokens * rates.cacheReadInputCostPerToken, 1e-9),
  'system prompt billed entirely at the cache-read rate')
const flatAverage = systemTokens * (expected - 500 * rates.outputCostPerToken) / 8000
assert(systemUsd < flatAverage / 10, 'positional pricing is >10x cheaper here than a flat average would claim')

console.log('no cache: everything pays fresh input')
const cold = attributeCost(segments, { inputTokens: 8000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, {}, rates)
const coldSum = Object.values(cold).reduce((a, b) => a + b, 0)
assert(near(coldSum, 8000 * rates.inputCostPerToken, 1e-9), 'cold request sums to fresh input cost')

console.log('normalization')
const normalized = normalizeTo({ 'a|b': 1, 'c|d': 3 }, 8)
assert(near(normalized['a|b'], 2) && near(normalized['c|d'], 6), 'scales to the billed total, keeping proportions')
assert(Object.keys(normalizeTo({}, 5)).length === 0, 'empty attribution stays empty')

console.log('degenerate input')
assert(segmentsOf({}).length === 0, 'empty request yields no segments')
assert(segmentsOf(undefined).length === 0, 'undefined request does not throw')
assert(Object.keys(attributeCost([], usage, {}, rates)).length === 1, 'no segments: only the output row')

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
