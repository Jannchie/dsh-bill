/**
 * Model pricing for dsh-bill.
 *
 * The catalogue, the name normalization, the DeepSeek peak/off-peak schedules
 * and the effective-date machinery all live in `llm-pricing` now; this module
 * is the adapter between that library and what the plugin stores:
 *
 *   - DSH usage chunks report `inputTokens` as the UNCACHED part of the
 *     prompt, while llm-pricing takes the prompt TOTAL and subtracts the
 *     cache splits out of it. `tokenCounts()` is that translation, and it is
 *     the one place the two conventions meet.
 *   - A record is priced at its own timestamp (`at`), so historical rows are
 *     never re-priced when a vendor changes rates or when the UTC hour moves
 *     DeepSeek between its peak and off-peak windows.
 *   - Plugin config `priceOverrides` become llm-pricing overrides, which
 *     outrank every catalogue.
 *
 * Currency handling stays here: llm-pricing is USD-internal (as is the whole
 * plugin API), but the dashboard shows each model's base rate in the currency
 * its vendor actually publishes, and the USD→* table below is what the
 * browser converts with.
 *
 * @module dsh-bill/pricing
 */

import { PricingCatalog, modelsDevSource, openRouterSource } from 'llm-pricing'
import { fileCache } from 'llm-pricing/node'

/**
 * models.dev is the primary catalogue: it quotes every provider separately,
 * so first-party rates are reachable instead of whichever reseller a router
 * would have picked. OpenRouter fills in what models.dev does not list.
 */
function buildCatalog(overrides) {
  return new PricingCatalog({
    sources: [modelsDevSource(), openRouterSource()],
    // Shared across restarts (models.dev is ~4 MB); a cache failure is
    // warned about and ignored by the library, never fatal.
    cache: fileCache(),
    overrides,
    onWarn: (message, error) => {
      console.warn('[dsh-bill] pricing:', message, error?.message ?? error ?? '')
    },
  })
}

let catalog = buildCatalog()

/**
 * Vendors that publish their price list in a currency other than USD. The
 * stored rates are always USD (the pricing basis); this only decides which
 * currency the dashboard renders a model's *base rate* in, converting with
 * the fx table below.
 */
const NATIVE_CURRENCY_RULES = [
  { test: (model) => model.includes('deepseek'), currency: 'CNY' },
]

/** The currency a model's vendor publishes its price list in. */
export function currencyFor(model) {
  const name = String(model ?? '').toLowerCase()
  for (const rule of NATIVE_CURRENCY_RULES) {
    if (rule.test(name)) return rule.currency
  }
  return 'USD'
}

/** Load the catalogue if stale (24h TTL); safe to call per request. */
export function ensurePricingLoaded() {
  return catalog.ensureLoaded()
}

/** Catalogue provenance for diagnostics: { status, loadedAt, source, size }. */
export function pricingState() {
  return catalog.state()
}

/**
 * Translate a DSH usage record into llm-pricing token counts.
 *
 * DSH reports the three input buckets disjointly (`inputTokens` is what was
 * neither read from nor written to the cache); llm-pricing expects the prompt
 * total and derives the fresh part by subtraction. Summing here is what keeps
 * cache tokens from being billed twice — once at their own rate and once as
 * part of the prompt.
 */
function tokenCounts(rec) {
  const uncached = rec.inputTokens ?? 0
  const cacheRead = rec.cacheReadTokens ?? 0
  const cacheWrite = rec.cacheWriteTokens ?? 0
  return {
    inputTokens: uncached + cacheRead + cacheWrite,
    cachedInputTokens: 0,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    outputTokens: rec.outputTokens ?? 0,
    // Informational only — providers already fold reasoning into output.
    reasoningOutputTokens: rec.reasoningTokens ?? 0,
  }
}

/**
 * The per-token rate card in force for one model at one instant, or null when
 * no catalogue prices it. Exposed for cost attribution, which needs the
 * individual rates rather than one total.
 */
export function ratesFor(model, at) {
  return catalog.getPrice(model, at)
}

/** Whether an instant falls inside any peak window (UTC hours, half-open). */
function isPeakHour(timeMs, windows) {
  const hour = new Date(timeMs).getUTCHours()
  return windows.some(([start, end]) => (start <= end
    ? hour >= start && hour < end
    : hour >= start || hour < end))
}

/** The schedule period in force at `timeMs` (periods are ascending by `from`). */
function periodAt(schedule, timeMs) {
  let period = schedule.periods[0]
  for (const candidate of schedule.periods) {
    if (timeMs >= candidate.from) period = candidate
    else break
  }
  return period
}

/**
 * Which side of a peak/off-peak schedule a call landed on.
 *
 * `null` for every model that bills one rate around the clock — which is all
 * of them except DeepSeek's first-party API — so the UI can tell "no peak
 * pricing applies" apart from "all off-peak".
 *
 * Derived from the schedule rather than tracked separately: the peak windows
 * live in llm-pricing next to the rates they select, so a vendor that gains
 * or loses a peak schedule flows through here without a change.
 */
export function peakStateFor(model, timeMs) {
  const schedule = catalog.getSchedule(model)
  if (!schedule) return null
  const period = periodAt(schedule, timeMs)
  if (!period?.peak) return null
  return isPeakHour(timeMs, period.peak.windowsUtc) ? 'peak' : 'offpeak'
}

/**
 * The off-peak rate card for a model at an instant, or null when it has no
 * peak schedule then.
 *
 * The counterfactual "what would this call have cost in the cheap window" — the
 * period's base rates, which are exactly what a peak call is charged instead
 * of. Lets the report quantify what peak hours cost rather than only reporting
 * how much of the bill landed in them.
 */
export function offPeakRatesFor(model, timeMs) {
  const schedule = catalog.getSchedule(model)
  if (!schedule) return null
  const period = periodAt(schedule, timeMs)
  if (!period?.peak) return null
  return period.rates
}

/**
 * Price one call at its own timestamp.
 *
 * @param rec - { model, time, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 * @returns { usd, priced, displayName, base, peak } — `usd` is null when no
 *          catalogue lists the model, which the UI shows as unpriced rather
 *          than as $0. `peak` is 'peak' | 'offpeak' | null (see peakStateFor).
 */
export function priceRecord(rec) {
  const model = rec.model
  const at = rec.time
  const price = catalog.getPrice(model, at)
  if (!price) {
    return { usd: null, priced: false, displayName: undefined, base: null, peak: null }
  }
  const { cost } = catalog.estimate({ model, at, ...tokenCounts(rec) })
  return {
    usd: roundCost(cost),
    priced: true,
    displayName: price.displayName,
    peak: peakStateFor(model, at),
    base: {
      inputPerM: price.inputCostPerToken * 1e6,
      outputPerM: price.outputCostPerToken * 1e6,
      cacheReadPerM: price.cacheReadInputCostPerToken * 1e6,
      // Official pricing currency of this model (DeepSeek → CNY, others → USD)
      currency: currencyFor(model),
    },
  }
}

/**
 * Rebuild the catalogue with the plugin's `priceOverrides` config applied.
 *
 * Config shape is per-million USD (`{ inputPerM, outputPerM, cacheReadPerM,
 * cacheWritePerM, displayName }`), keyed by model id with an optional
 * `vendor/` prefix. An entry missing input or output is skipped rather than
 * priced at 0.
 */
export function mergeOverrides(overrides) {
  const built = {}
  for (const [key, override] of Object.entries(overrides ?? {})) {
    const slash = key.indexOf('/')
    const model = (slash > 0 ? key.slice(slash + 1) : key).toLowerCase()
    const input = Number(override.inputPerM)
    const output = Number(override.outputPerM)
    const cacheRead = Number(override.cacheReadPerM)
    const cacheWrite = Number(override.cacheWritePerM)
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    const read = (Number.isFinite(cacheRead) ? cacheRead : input * 0.1) / 1e6
    built[model] = {
      displayName: override.displayName ?? model,
      source: 'override',
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: {
          inputCostPerToken: input / 1e6,
          cacheCreationInputCostPerToken: (Number.isFinite(cacheWrite) ? cacheWrite : input) / 1e6,
          cacheReadInputCostPerToken: read,
          cachedInputCostPerToken: read,
          outputCostPerToken: output / 1e6,
        },
      }],
    }
  }
  // A catalogue's overrides are fixed at construction, so applying config
  // means building a new one. This runs once, at plugin apply.
  catalog = buildCatalog(built)
  return built
}

/** Round to 6 significant digits (sub-cent precision, no float noise). */
export function roundCost(value) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toPrecision(6))
}

// ── USD → all-currencies exchange rates ─────────────────────────────────────
//
// The host owns conversion: it fetches a live USD-based rate table (exchangerate-api,
// ~166 currencies, refreshed daily; frankfurter/ECB as backup), falls back to a
// hardcoded parity table when offline, and serves the whole table to the browser so
// every component converts identically and the user can pick any currency.

/** Offline fallback parities (USD per 1 unit shown as 1 USD = x). CFETS 2026-08-14 where noted. */
export const DEFAULT_FX = {
  USD: 1,
  CNY: 6.7878, // CFETS central parity 2026-08-14
  EUR: 0.864617,
  GBP: 0.738821,
  JPY: 159.237179,
  HKD: 7.847535,
  KRW: 1415.43407,
  INR: 95.531266,
  AUD: 1.412299,
  CAD: 1.38728,
  SGD: 1.278969,
  TWD: 31.971691,
  MYR: 4.086106,
  THB: 33.127366,
  CHF: 0.845, // rough parity; live value preferred
  NZD: 1.52, // rough parity; live value preferred
}
const FX_SOURCES = [
  'https://open.er-api.com/v6/latest/USD', // exchangerate-api: ~166 currencies
  'https://api.frankfurter.app/latest?from=USD', // ECB: ~30 currencies
]
const FX_REFRESH_MS = 24 * 60 * 60 * 1000

let fxState = {
  rates: { ...DEFAULT_FX },
  source: 'default', // 'live' | 'default'
  loadedAt: 0,
}
let fxInflight = null

async function loadFx() {
  for (const url of FX_SOURCES) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) continue
      const json = await response.json()
      const raw = json?.rates
      if (!raw || typeof raw !== 'object') continue
      const rates = { ...DEFAULT_FX }
      let count = 0
      for (const [code, value] of Object.entries(raw)) {
        const n = Number(value)
        if (Number.isFinite(n) && n > 0) {
          rates[code.toUpperCase()] = n
          count++
        }
      }
      if (count > 0) {
        rates.USD = 1
        fxState = { rates, source: 'live', loadedAt: Date.now() }
        return
      }
    } catch { /* try next source */ }
  }
  fxState = { rates: { ...DEFAULT_FX }, source: 'default', loadedAt: Date.now() }
}

/** Ensure the FX table is loaded (24h TTL); shares one in-flight fetch. */
export function ensureFxLoaded() {
  if (fxState.source === 'live' && Date.now() - fxState.loadedAt < FX_REFRESH_MS) {
    return Promise.resolve()
  }
  if (!fxInflight) {
    fxInflight = loadFx().finally(() => { fxInflight = null })
  }
  return fxInflight
}

/** Current USD-based rate table + provenance. */
export function getFx() {
  return { rates: fxState.rates, source: fxState.source }
}
