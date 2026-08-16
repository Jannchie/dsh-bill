/**
 * Smoke tests for the dsh-cost-money pricing adapter over `llm-pricing`.
 * Offline-capable: the catalogue falls back to llm-pricing's bundled archive.
 * Run: node tests/pricing.test.js
 */
import {
  currencyFor, ensureFxLoaded, getFx, mergeOverrides, peakStateFor, priceRecord, roundCost,
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

console.log('native currency')
assert(currencyFor('deepseek-v4-flash') === 'CNY', 'deepseek prices in CNY')
assert(currencyFor('gpt-5') === 'USD', 'gpt-5 prices in USD')
assert(flat.base.currency === 'CNY', 'record base carries the native currency')

console.log('unknown model')
const unknown = priceRecord(rec('totally-made-up-model-xyz', beforePeak, { inputTokens: 1e6 }))
assert(unknown.usd === null && !unknown.priced, 'unknown model is unpriced, not $0')

console.log('priceOverrides')
mergeOverrides({ 'acme/test-1': { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 } })
const custom = priceRecord(rec('acme/test-1', Date.now(), { inputTokens: 1e6, outputTokens: 1e6 }))
assert(custom.priced, 'priceOverrides adds an arbitrary model')
assert(Math.abs(custom.usd - 2) < 1e-6, 'override 1M in + 1M out = $2 (got ' + custom.usd + ')')

console.log('rounding')
assert(roundCost(Number.NaN) === 0, 'NaN rounds to 0')
assert(roundCost(0.1 + 0.2) === 0.3, 'float noise rounded away')

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
