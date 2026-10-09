/**
 * Smoke tests for the dsh-cost-money pricing adapter over `llm-pricing`.
 * Offline-capable: the catalogue falls back to llm-pricing's bundled archive.
 * Run: node tests/pricing.test.js
 */
import {
  cacheWrite1hOf, cacheWriteRateOf, currencyFor, ensureFxLoaded, getFx, mergeOverrides, peakStateFor, priceRecord,
  ratesFor, roundCost, setRateCurrency,
} from '../lib/pricing.js'

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** One call record with only the fields the pricer reads. */
function rec(model, time, tokens = {}) {
  return {
    model,
    time,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...tokens,
  }
}

console.log('deepseek-v4-flash peak / off-peak')
const beforePeak = Date.UTC(2026, 7, 15) // before the 2026-08-16 16:00Z change
const inPeak = Date.UTC(2026, 7, 17, 2) // peak window 01-04 UTC
const offPeak = Date.UTC(2026, 7, 17, 12) // off-peak

const flat = priceRecord(rec('deepseek-v4-flash', beforePeak, { inputTokens: 1e6 }))
const peak = priceRecord(rec('deepseek-v4-flash', inPeak, { inputTokens: 1e6 }))
const off = priceRecord(rec('deepseek-v4-flash', offPeak, { inputTokens: 1e6 }))
assert(flat.priced, 'deepseek-v4-flash resolves a price')
assert(Math.abs(flat.usd - 0.14) < 1e-6, 'pre-change input $0.14/MTok (got ' + flat.usd + ')')
assert(Math.abs(peak.usd - 0.44) < 1e-6, 'peak input $0.44/MTok (got ' + peak.usd + ')')
assert(Math.abs(off.usd - 0.22) < 1e-6, 'off-peak input $0.22/MTok (got ' + off.usd + ')')
assert(Math.abs(flat.base.inputPerM - 0.14) < 1e-9, 'base rate exposed per MTok')

console.log('cost computation')
const both = priceRecord(rec('deepseek-v4-flash', beforePeak, { inputTokens: 1e6, outputTokens: 1e6 }))
assert(Math.abs(both.usd - (0.14 + 0.28)) < 1e-6, '1M in + 1M out ≈ $0.42 (got ' + both.usd + ')')

// DSH reports the three input buckets disjointly: cache tokens must bill at
// their own rate, not also as fresh prompt.
const cached = priceRecord(rec('deepseek-v4-flash', beforePeak, { inputTokens: 0, cacheReadTokens: 1e6 }))
assert(Math.abs(cached.usd - 0.0028) < 1e-6, '1M cache-read ≈ $0.0028, not billed as fresh input (got ' + cached.usd + ')')

console.log('peak state')
assert(peakStateFor('deepseek-v4-flash', inPeak) === 'peak', '01-04 UTC is peak')
assert(peakStateFor('deepseek-v4-flash', Date.UTC(2026, 7, 17, 7)) === 'peak', '06-10 UTC is peak')
assert(peakStateFor('deepseek-v4-flash', offPeak) === 'offpeak', '12:00 UTC is off-peak')
assert(peakStateFor('deepseek-v4-flash', beforePeak) === null, 'before the schedule took effect: no peak split')
assert(peakStateFor('gpt-5', inPeak) === null, 'flat-priced model has no peak state')
assert(peakStateFor('totally-made-up-model-xyz', inPeak) === null, 'unknown model has no peak state')
assert(peak.peak === 'peak' && off.peak === 'offpeak', 'priced records carry their peak state')

// A peak window is not only its hours: since 2026-08-23 DeepSeek bills the
// off-peak rate around the clock at weekends. llm-pricing prices that
// correctly either way, so the tag is the only thing that can drift out of
// step with the bill — assert the two agree rather than the tag alone.
console.log('weekends (off-peak around the clock since 2026-08-23)')
const satBefore = Date.UTC(2026, 7, 22, 2) // Saturday, weekday-only rule not yet in force
const satAfter = Date.UTC(2026, 7, 29, 2) // Saturday, inside 01-04 UTC
const sunAfter = Date.UTC(2026, 7, 30, 2) // Sunday, inside 01-04 UTC
const perM = (time) => priceRecord(rec('deepseek-v4-flash', time, { inputTokens: 1e6 }))
assert(peakStateFor('deepseek-v4-flash', satBefore) === 'peak', 'a peak-hour Saturday before the change is still peak')
assert(Math.abs(perM(satBefore).usd - 0.44) < 1e-6, '... and is billed at the peak rate')
assert(peakStateFor('deepseek-v4-flash', satAfter) === 'offpeak', 'a peak-hour Saturday after the change is off-peak')
assert(Math.abs(perM(satAfter).usd - 0.22) < 1e-6, '... and is billed at the off-peak rate')
assert(peakStateFor('deepseek-v4-flash', sunAfter) === 'offpeak', 'a peak-hour Sunday after the change is off-peak')
assert(Math.abs(perM(sunAfter).usd - 0.22) < 1e-6, '... and is billed at the off-peak rate')

console.log('native currency')
assert(currencyFor('deepseek-v4-flash') === 'CNY', 'deepseek prices in CNY')
assert(currencyFor('gpt-5') === 'USD', 'gpt-5 prices in USD')
setRateCurrency('USD')
assert(currencyFor('deepseek-v4-flash') === 'USD', 'rateCurrency renders deepseek in the configured currency')
setRateCurrency('EUR')
assert(currencyFor('gpt-5') === 'EUR', 'rateCurrency applies to every model')
setRateCurrency('XYZ')
assert(currencyFor('deepseek-v4-flash') === 'CNY', 'an unknown code is ignored rather than rendered')
setRateCurrency(undefined)
assert(currencyFor('deepseek-v4-flash') === 'CNY', 'clearing rateCurrency restores the vendor rules')
assert(flat.base.currency === 'CNY', 'record base carries the native currency')

console.log('unknown model')
const unknown = priceRecord(rec('totally-made-up-model-xyz', beforePeak, { inputTokens: 1e6 }))
assert(unknown.usd === null && !unknown.priced, 'unknown model is unpriced, not $0')
// Regression: the unpriced shape must be lossless JSON. `bill_stats` folds this
// object into a byModel row and returns it, and the host's validator rejects the
// ENTIRE tree when any own property holds `undefined` — which `JSON.stringify`
// hides, so a disk round trip never caught it. `displayName: undefined` here was
// the bug that made every bill_stats call fail on a machine with unpriced models.
for (const [key, value] of Object.entries(unknown)) {
  assert(value !== undefined, 'unpriced result has no `undefined` property (' + key + ')')
}
assert(Object.prototype.hasOwnProperty.call(unknown, 'displayName') && unknown.displayName === null,
  'unpriced displayName is an explicit null, so the key survives JSON (' + JSON.stringify(unknown.displayName) + ')')
assert(JSON.parse(JSON.stringify(unknown)).displayName === null,
  'the unpriced shape round-trips through JSON without losing the displayName key')
console.log('priceOverrides')
mergeOverrides({ 'acme/test-1': { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 } })
const custom = priceRecord(rec('acme/test-1', Date.now(), { inputTokens: 1e6, outputTokens: 1e6 }))
assert(custom.priced, 'priceOverrides adds an arbitrary model')
assert(Math.abs(custom.usd - 2) < 1e-6, 'override 1M in + 1M out = $2 (got ' + custom.usd + ')')

console.log('rounding')
assert(roundCost(Number.NaN) === 0, 'NaN rounds to 0')
assert(roundCost(0.1 + 0.2) === 0.3, 'float noise rounded away')

// A router addresses a model by its own id — provider prefix, plus the routing
// tier it ran — and Cursor spells Claude family-last. The catalogue keys on the
// vendor's name, so those calls used to bill as `?`. llm-pricing >= 0.18
// resolves them (`peelRoutingTiers`); this pins the behaviour this plugin
// relies on. Driven entirely by overrides, so it stays offline and
// deterministic.
console.log('router ids resolve to the catalogue key they meant')
mergeOverrides({
  'claude-opus-9.9': { inputPerM: 5, outputPerM: 25 },
  'grok-9.9': { inputPerM: 5, outputPerM: 25 },
  'grok-9.9-fast': { inputPerM: 30, outputPerM: 150 },
  'weird-model': { inputPerM: 1, outputPerM: 1 },
  'weird-model-thinking': { inputPerM: 99, outputPerM: 99 },
})
const both1M = (model) => priceRecord(rec(model, Date.now(), { inputTokens: 1e6, outputTokens: 1e6 }))
assert(Math.abs(both1M('claude-opus-9.9').usd - 30) < 1e-6, 'baseline: 5/25 per M = $30')
assert(Math.abs(both1M('gw/claude-opus-9.9-high').usd - 30) < 1e-6, 'provider prefix + -high resolves to the same $30')
assert(Math.abs(both1M('gw/claude-opus-9.9-thinking').usd - 30) < 1e-6, '-thinking resolves to the same $30')
assert(Math.abs(both1M('cursor/claude-9.9-opus-high').usd - 30) < 1e-6, 'family-last + -high resolves to the same $30')

// -fast is a real rate multiplier, not a routing tier: peeling it would bill a
// 6x model at its base rate, which is worse than showing `?`.
assert(Math.abs(both1M('grok-9.9-fast').usd - 180) < 1e-6, '-fast alone keeps its 6x rate ($180)')
assert(Math.abs(both1M('grok-9.9-high-fast').usd - 180) < 1e-6, '-high-fast peels the tier but KEEPS -fast ($180)')
assert(Math.abs(both1M('cursor/grok-9.9-xhigh-fast').usd - 180) < 1e-6, 'prefix + -xhigh-fast also keeps -fast ($180)')

// Literal wins: `weird-model-thinking` is itself priced, so it must not be
// rewritten to the cheaper `weird-model` by a suffix peel.
assert(Math.abs(both1M('weird-model-thinking').usd - 198) < 1e-6, 'a literal catalogue key is never shadowed by a rewrite ($198, not $2)')

// Resolution finds a real entry or nothing — it never invents one.
const nothing = both1M('gw/weird-model-2-high')
assert(nothing.usd === null && !nothing.priced, 'no catalogue entry anywhere stays unpriced, not $0')

console.log('one-hour cache writes are priced from the reported split')
// A five-minute write is the card's cache-write rate; a one-hour write is what
// llm-pricing bills for `cacheCreation1hInputTokens`. The split rides on the
// usage report as `cacheWrite1hTokens`, a subset of `cacheWriteTokens`.
mergeOverrides({ 'ttl-test-model': { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 } })
const writes = (long) => priceRecord(rec('ttl-test-model', beforePeak, {
  cacheWriteTokens: 1e6, ...(long === undefined ? {} : { cacheWrite1hTokens: long }),
})).usd
const shortOnly = writes(undefined)
assert(Math.abs(shortOnly - 5) < 1e-6, 'no split: every write at the five-minute rate (got ' + shortOnly + ')')
assert(writes(0) === shortOnly, 'a zero split prices exactly like no split')
const longOnly = writes(1e6)
assert(longOnly > shortOnly, 'one-hour writes cost more than five-minute writes (' + longOnly + ' > ' + shortOnly + ')')
const mixed = writes(4e5)
assert(Math.abs(mixed - (0.6 * shortOnly + 0.4 * longOnly)) < 1e-6, 'a mixed call prices each share at its own rate (got ' + mixed + ')')
assert(writes(5e6) === longOnly, 'an over-reported split cannot bill more writes than there were')
assert(cacheWrite1hOf({ cacheWriteTokens: 10, cacheWrite1hTokens: 99 }) === 10, 'cacheWrite1hOf clamps to the write total')
assert(cacheWrite1hOf({ cacheWriteTokens: 10 }) === 0 && cacheWrite1hOf(undefined) === 0, 'cacheWrite1hOf is 0 without a split')
const card = ratesFor('ttl-test-model', beforePeak)
const blended = cacheWriteRateOf(card, { cacheWriteTokens: 1e6, cacheWrite1hTokens: 4e5 }) * 1e6
assert(Math.abs(blended - mixed) < 1e-6, 'the hand-pricing write rate agrees with priceRecord (got ' + blended + ')')
assert(cacheWriteRateOf(card, { cacheWriteTokens: 1e6 }) === card.cacheCreationInputCostPerToken, 'without a split the hand-pricing rate is the card rate')
mergeOverrides(undefined)

console.log('fx')
ensureFxLoaded().then(() => {
  const fx = getFx()
  assert(fx.rates && typeof fx.rates === 'object', 'fx table loaded with ' + Object.keys(fx.rates).length + ' currencies (' + fx.source + ')')
  assert(fx.rates.USD === 1, 'USD base is 1')
  assert(fx.rates.CNY > 0, 'CNY rate present: ' + fx.rates.CNY)
  assert(fx.source === 'live' || fx.source === 'default', 'fx source is live or default')
  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}).catch((e) => {
  console.error('fx load threw:', e)
  process.exit(1)
})
