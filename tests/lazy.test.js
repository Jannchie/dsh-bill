/**
 * Unit tests for the lazy-tool judgement (lib/lazy.js).
 * Run: node tests/lazy.test.js
 */
import {
  createLazyMatcher,
  recentText,
  DEFAULT_LAZY_PATTERN as DEFAULT_PATTERN,
} from '../lib/lazy.js'

// The one-shot `looksLikeCostQuestion` convenience was removed (no
// production code used it); the same judgement is exercised through the
// public cached matcher — a fresh matcher compiles its source on first
// use, so behaviour is identical to a one-shot call.
const lazy = (text, pattern) => createLazyMatcher()(text, pattern)

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}


console.log('cost judgement — positive')
assert(lazy('这个会话花了多少钱', DEFAULT_PATTERN), 'Chinese spend question matches')
assert(lazy('What did this session cost?', DEFAULT_PATTERN), 'English cost question matches')
assert(lazy('show usage across sessions', DEFAULT_PATTERN), 'usage alternative matches')
assert(lazy('下个月预算和账单', DEFAULT_PATTERN), 'billing alternative matches')
assert(lazy('bill_stats', DEFAULT_PATTERN), 'explicit tool name matches')
assert(lazy('这个月大概多少钱', DEFAULT_PATTERN), 'the bare 多少钱 question matches')
assert(lazy('看一下这个月的用量', DEFAULT_PATTERN), 'standalone 用量 matches')
assert(lazy('统计一下支出和开销', DEFAULT_PATTERN), '支出 and 开销 match')
assert(lazy('how much did we spend last month', DEFAULT_PATTERN), 'how much and spent match')
assert(lazy('what is the total price', DEFAULT_PATTERN), 'price matches')

console.log('cost judgement — negative')
assert(!lazy('帮我重构一下这个模块', DEFAULT_PATTERN), 'unrelated refactor request does not match')
assert(!lazy('explain this diff to me', DEFAULT_PATTERN), 'unrelated english request does not match')
assert(!lazy('', DEFAULT_PATTERN), 'empty text does not match')
assert(!lazy(undefined, DEFAULT_PATTERN), 'undefined text coerces to empty and does not match')
console.log('cost judgement — safety defaults')
assert(lazy('anything at all', ''), 'empty pattern is always relevant (never hides the tool)')
assert(lazy('anything at all', null), 'null pattern is always relevant')
assert(lazy('anything at all', '(['), 'an invalid pattern degrades to always relevant')
console.log('cost judgement — regex power')
assert(lazy('花了 3.5 美元', '花了\\s*[0-9]'), 'regex quantifiers work (花了 + digits)')
assert(!lazy('花了钱', '花了\\s*[0-9]'), 'regex without a digit does not match')
assert(lazy('THIS SESSION COST WHAT?', DEFAULT_PATTERN), 'uppercase COST matches')
assert(lazy('bIll_sTaTs', DEFAULT_PATTERN), 'mixed-case tool name matches')

console.log('createLazyMatcher — cached per-source matcher')
const matcher = createLazyMatcher()
assert(matcher('what did it cost', DEFAULT_PATTERN), 'matches with a compiled source')
assert(!matcher('unrelated text', DEFAULT_PATTERN), 'rejects unrelated text')
assert(matcher('anything at all', ''), 'empty source is always relevant')
assert(matcher('anything at all', '(['), 'an invalid source is always relevant')
assert(matcher('total cost so far', 'cost'), 'a changed source recompiles and takes effect')
assert(!matcher('what did it cost', '账单'), 'the new source is authoritative')


console.log('recentText — message extraction')
const msgs = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'here is the answer' }] },
  { role: 'user', content: [{ type: 'text', text: 'how much did we spend' }] },
]
assert(recentText(msgs, 6) === 'hello\nhere is the answer\nhow much did we spend', 'joins text blocks in order')
assert(recentText(msgs, 1) === 'how much did we spend', 'lookback 1 takes only newest')
assert(recentText(msgs, 2) === 'here is the answer\nhow much did we spend', 'lookback 2 takes two')
assert(recentText([], 3) === '', 'empty message list gives empty string')
assert(recentText(null, 3) === '', 'null message list gives empty string')
console.log('recentText — text-less entries do not consume slots')
const withResult = [
  { role: 'user', content: [{ type: 'text', text: 'how much did we spend' }] },
  { role: 'user', content: [{ type: 'tool-result', callId: 'x', name: 'bill_stats' }] },
]
assert(recentText(withResult, 1) === 'how much did we spend', 'a text-less tool result does not consume a lookback slot')
assert(recentText(withResult, 2) === 'how much did we spend', 'and a bigger window still finds the question once')
const allResults = [
  { role: 'user', content: [{ type: 'tool-result', callId: 'x' }] },
  { role: 'user', content: [{ type: 'tool-result', callId: 'y' }] },
]
assert(recentText(allResults, 5) === '', 'an all-tool-result tail yields no text')

console.log('recentText — block shapes')
const mixed = [
  { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'tool-use', id: 'x', name: 'foo' }] },
  { role: 'user', content: 'bare string content' },
  { role: 'user', content: [{ type: 'text', text: 'b' }] },
]
assert(recentText(mixed, 10) === 'a\nb', 'non-text blocks skipped, bare string yields no text, order preserved')

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
