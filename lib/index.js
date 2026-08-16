/**
 * Host half of dsh-bill.
 *
 * Captures every model call through the `llm/stream` waterfall, prices it
 * immediately at its own timestamp (via `llm-pricing`: models.dev + OpenRouter
 * catalogues, DeepSeek peak/off-peak schedules, user overrides), keeps a
 * bounded in-memory ring,
 * persists to `$DSH_HOME/dsh-bill/records.jsonl` (default `~/.dsh/...`,
 * cwd-independent), and serves a JSON API at `POST /dsh-bill/api` for the
 * browser half:
 *
 *   { action: 'session-cost', sessionId }  → one session's totals + per-model
 *   { action: 'dashboard', rangeDays? }    → global KPI / per-model / timeline
 *   { action: 'fx' }                       → effective USD→CNY rate
 *
 * All monetary values are returned in USD (the pricing basis); the browser
 * converts to the user's chosen display currency with the served fx rate, so
 * switching currencies is instant and identical across every component.
 *
 * Fail-soft contract: when `webServer` is absent the plugin is a no-op
 * (nothing to display). Persistence uses node:fs directly against the
 * harness home, so it works regardless of the DSH `fs` service or cwd.
 *
 * @module dsh-bill
 */

import { mkdirSync, promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { attributeCost, normalizeTo, segmentsOf } from './attribution.js'
import {
  ensureFxLoaded, ensurePricingLoaded, getFx, mergeOverrides, peakStateFor,
  priceRecord as priceWithCatalog, ratesFor, roundCost,
} from './pricing.js'

/** Maximum in-memory records (ring cap; persisted file keeps more). */
const MAX_RECORDS = 20000

/**
 * Cordis plugin entry (object form with a hard dependency on `webServer`).
 *
 * Why `inject`, not a bare `ctx.get('webServer')` probe: the HTTP carrier is
 * a Service that may not have initialized when this plugin's apply runs —
 * cordis resolves hard dependencies before applying, so declaring the inject
 * guarantees the route is registered only after the carrier is ready. A plain
 * probe would silently skip the route (the observed failure: POSTs to
 * /dsh-bill/api fell through to the SPA fallback and returned 405).
 *
 * The Loader passes `undefined` for a config-less row, so defaults are
 * resolved here. `fs` stays optional (in-memory-only recording when absent).
 */
export default {
  inject: ['webServer'],
  apply(ctx, config = null) {
    const cfg = config && typeof config === 'object' ? config : {}
    mergeOverrides(cfg.priceOverrides)

  /** In-memory ring of call records. */
  let records = []
  /** Map sessionId → its call indices into `records` (for session-cost). */
  const bySession = new Map()
  let recordSeq = 0

  /** Serialized persistence queue (fs writes are ordered and best-effort). */
  let persistQueue = Promise.resolve()

  /**
   * Global data directory under the harness home (~/.dsh or $DSH_HOME) —
   * NOT relative to the session cwd. The DSH `fs` service resolves paths
   * against the workspace, which would scatter records per project and change
   * with the working directory; a fixed home-relative file is the stable,
   * single-store location (mirrors how dsh itself keeps settings/storages).
   */
  function recordsFile() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    return join(home, 'dsh-bill', 'records.jsonl')
  }

  /**
   * Where records lived before the plugin was renamed from `dsh-cost-money`.
   *
   * Read once at startup when the current file does not exist yet, so a rename
   * does not look like "all my history is gone". The old file is left in place
   * rather than moved or deleted: the first write lands in the new location,
   * and an untouched backup costs nothing.
   */
  function legacyRecordsFile() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    return join(home, 'dsh-cost-money', 'records.jsonl')
  }

  /** Load persisted records at startup (best effort, node fs — cwd-independent). */
  async function loadPersisted() {
    try {
      const file = recordsFile()
      mkdirSync(join(file, '..'), { recursive: true })
      let text
      try {
        text = await fsPromises.readFile(file, 'utf8')
      } catch {
        text = await fsPromises.readFile(legacyRecordsFile(), 'utf8')
      }
      const loaded = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { loaded.push(JSON.parse(line)) } catch { /* skip malformed line */ }
      }
      if (loaded.length === 0) return
      records = loaded.slice(-MAX_RECORDS)
      backfillPeak()
      rebuildSessionIndex()
    } catch { /* no persisted file yet */ }
  }

  /**
   * Fill in `peak` on records written before the field existed.
   *
   * Only the peak/off-peak tag is derived — `usd` is deliberately left alone.
   * Re-pricing history is exactly what the schedule machinery exists to
   * prevent, and a record's stored cost is what was actually billed. The tag
   * is a pure function of (model, time), so deriving it later gives the same
   * answer it would have had at capture.
   */
  function backfillPeak() {
    for (const rec of records) {
      if (rec && rec.peak === undefined) rec.peak = peakStateFor(rec.model, rec.time)
    }
  }

  /** Rebuild `bySession` from the current ring (used after load/eviction). */
  function rebuildSessionIndex() {
    bySession.clear()
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]
      if (!rec || !rec.sessionId) continue
      const list = bySession.get(rec.sessionId)
      if (list) list.push(i)
      else bySession.set(rec.sessionId, [i])
    }
  }

  /** Append the current ring to the JSONL file (ordered through a queue). */
  function persist() {
    persistQueue = persistQueue.then(async () => {
      try {
        const file = recordsFile()
        mkdirSync(join(file, '..'), { recursive: true })
        const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
        await fsPromises.writeFile(file, text, 'utf8')
      } catch { /* persistence is best-effort */ }
    }).catch(() => {})
  }

  /** Price one call at its own timestamp; store USD. Idempotent. */
  function priceRecord(rec) {
    if (rec.usd !== undefined && rec.usd !== null) return rec
    const priced = priceWithCatalog(rec)
    rec.usd = priced.usd
    rec.priced = priced.priced
    rec.displayName = priced.displayName
    rec.base = priced.base
    rec.peak = priced.peak
    return rec
  }

  /**
   * Attach the content-attribution map to a freshly captured record.
   *
   * Stored as `{ 'category|detail': usd }`, rounded — counts and dollars only,
   * never the text they were derived from. Skipped when the record could not
   * be priced (there is no bill to attribute) or when the request carried no
   * readable content.
   */
  function attachAttribution(rec, segments, outputChars) {
    if (!segments || !segments.length || !rec.priced || !(rec.usd > 0)) return
    try {
      const rates = ratesFor(rec.model, rec.time)
      if (!rates) return
      const raw = normalizeTo(attributeCost(segments, rec, outputChars, rates), rec.usd)
      const attr = {}
      for (const [key, usd] of Object.entries(raw)) {
        const rounded = roundCost(usd)
        if (rounded > 0) attr[key] = rounded
      }
      if (Object.keys(attr).length) rec.attr = attr
    } catch { /* attribution never blocks recording a call */ }
  }

  /** Record one model call (called from the llm/stream wrapper). */
  function recordCall(options, usage, startedAt, segments, outputChars) {
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : undefined
    const rec = priceRecord({
      seq: recordSeq++,
      time: startedAt,
      sessionId,
      provider: options?.provider ?? 'unknown',
      model: options?.model ?? 'unknown',
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    })
    attachAttribution(rec, segments, outputChars)
    records.push(rec)
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS)
      rebuildSessionIndex()
    } else if (sessionId) {
      const list = bySession.get(sessionId)
      if (list) list.push(records.length - 1)
      else bySession.set(sessionId, [records.length - 1])
    }
    persist()
  }

  // ── capture: wrap the llm/stream waterfall, observe usage, pass chunks ────
  ctx.on('llm/stream', (options, next) => {
    const source = next()
    const startedAt = Date.now()
    let usage = null
    // Categorize the request while it is in hand — the content is a pure
    // function of this call and is gone once the stream ends. Only the counts
    // survive; no prompt text is kept or persisted.
    let segments = null
    try { segments = segmentsOf(options) } catch { /* attribution is best-effort */ }
    // Output split (visible text vs thinking) as observed on the wire, since
    // the usage chunk reports one output total for both.
    const outputChars = { text: 0, reasoning: 0 }

    async function* observe() {
      try {
        for await (const chunk of source) {
          if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage
          else if (chunk && chunk.type === 'text-delta') outputChars.text += (chunk.text ?? '').length
          else if (chunk && chunk.type === 'reasoning-delta') outputChars.reasoning += (chunk.text ?? '').length
          yield chunk
        }
      } finally {
        if (usage) recordCall(options, usage, startedAt, segments, outputChars)
      }
    }
    return observe()
  })

  // ── aggregations ──────────────────────────────────────────────────────────
  /** Per-model fold of a record subset (all amounts USD). */
  function foldRecords(list) {
    const byModel = new Map()
    let totalUsd = 0
    let priced = true
    let tokens = 0
    let calls = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let uncachedInputTokens = 0
    let outputTokens = 0
    // Peak/off-peak split, over the records whose model actually has a
    // peak schedule (DeepSeek first-party). Records on flat-priced models
    // are counted in neither, so the share is a share of what peak pricing
    // could apply to, not of the whole bill.
    let peakUsd = 0
    let offPeakUsd = 0
    let peakCalls = 0
    let offPeakCalls = 0
    for (const rec of list) {
      priceRecord(rec)
      calls++
      tokens += (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0)
      uncachedInputTokens += rec.inputTokens ?? 0
      cacheReadTokens += rec.cacheReadTokens ?? 0
      cacheWriteTokens += rec.cacheWriteTokens ?? 0
      outputTokens += rec.outputTokens ?? 0
      if (rec.usd === null) priced = false
      else totalUsd += rec.usd
      if (rec.peak === 'peak') { peakUsd += rec.usd ?? 0; peakCalls++ }
      else if (rec.peak === 'offpeak') { offPeakUsd += rec.usd ?? 0; offPeakCalls++ }
      const key = `${rec.provider ?? 'unknown'}/${rec.model ?? 'unknown'}`
      let row = byModel.get(key)
      if (!row) {
        row = {
          provider: rec.provider, model: rec.model, displayName: rec.displayName,
          base: rec.base, usd: 0, priced: true, calls: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, peakUsd: 0, offPeakUsd: 0,
        }
        byModel.set(key, row)
      }
      row.usd += rec.usd ?? 0
      if (rec.usd === null) row.priced = false
      row.calls++
      row.inputTokens += rec.inputTokens ?? 0
      row.outputTokens += rec.outputTokens ?? 0
      row.cacheReadTokens += rec.cacheReadTokens ?? 0
      row.cacheWriteTokens += rec.cacheWriteTokens ?? 0
      if (rec.peak === 'peak') row.peakUsd += rec.usd ?? 0
      else if (rec.peak === 'offpeak') row.offPeakUsd += rec.usd ?? 0
    }
    const rows = [...byModel.values()]
      .map((row) => ({
        ...row,
        usd: roundCost(row.usd),
        peakUsd: roundCost(row.peakUsd),
        offPeakUsd: roundCost(row.offPeakUsd),
        base: row.base ?? null,
      }))
      .sort((a, b) => b.usd - a.usd)
    return {
      calls,
      tokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      totalUsd: roundCost(totalUsd),
      peakUsd: roundCost(peakUsd),
      offPeakUsd: roundCost(offPeakUsd),
      peakCalls,
      offPeakCalls,
      priced,
      byModel: rows,
    }
  }

  /**
   * Fold per-record attribution maps into the category → detail tree the
   * dashboard renders.
   *
   * `attributedUsd` is deliberately reported next to the range total: records
   * captured before this feature existed carry no attribution and can never
   * gain one (the content is not stored), so the UI must be able to say what
   * share of the bill the tree actually covers instead of implying it is all
   * of it.
   */
  function attribution(list, rangeDays) {
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0
    const byCat = new Map()
    let attributedUsd = 0
    let totalUsd = 0
    let attributedCalls = 0
    let calls = 0
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      calls++
      totalUsd += rec.usd ?? 0
      if (!rec.attr) continue
      attributedCalls++
      for (const [key, usd] of Object.entries(rec.attr)) {
        const split = key.indexOf('|')
        const cat = split > 0 ? key.slice(0, split) : key
        const sub = split > 0 ? key.slice(split + 1) : '—'
        let row = byCat.get(cat)
        if (!row) {
          row = { cat, usd: 0, children: new Map() }
          byCat.set(cat, row)
        }
        row.usd += usd
        row.children.set(sub, (row.children.get(sub) ?? 0) + usd)
        attributedUsd += usd
      }
    }
    // Fold the long tail: a category with 30 one-off MCP tool names is a wall
    // of noise, and the folded row keeps the full amount rather than dropping it.
    const MAX_CHILDREN = 6
    const categories = [...byCat.values()]
      .map((row) => {
        const children = [...row.children.entries()]
          .map(([sub, usd]) => ({ sub, usd }))
          .sort((a, b) => b.usd - a.usd)
        let shown = children
        if (children.length > MAX_CHILDREN) {
          const rest = children.slice(MAX_CHILDREN - 1)
          shown = children.slice(0, MAX_CHILDREN - 1).concat({
            sub: `其他（${rest.length} 项）`,
            usd: rest.reduce((sum, c) => sum + c.usd, 0),
            folded: true,
          })
        }
        return {
          cat: row.cat,
          usd: roundCost(row.usd),
          children: shown.map((c) => ({ ...c, usd: roundCost(c.usd) })),
        }
      })
      .sort((a, b) => b.usd - a.usd)
    return {
      categories,
      attributedUsd: roundCost(attributedUsd),
      attributedCalls,
      rangeUsd: roundCost(totalUsd),
      rangeCalls: calls,
    }
  }

  /** Global timeline buckets (by day, then by hour) for the dashboard. */
  function timeline(list, rangeDays) {
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0
    const byDay = new Map()
    const byHour = new Map()
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      const day = new Date(rec.time).toISOString().slice(0, 10)
      let dayRow = byDay.get(day)
      if (!dayRow) {
        dayRow = { day, usd: 0, calls: 0, tokens: 0 }
        byDay.set(day, dayRow)
      }
      dayRow.usd += rec.usd ?? 0
      dayRow.calls++
      dayRow.tokens += (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0)
      const hour = new Date(rec.time).toISOString().slice(0, 13)
      let hourRow = byHour.get(hour)
      if (!hourRow) {
        hourRow = { hour, usd: 0, calls: 0, tokens: 0 }
        byHour.set(hour, hourRow)
      }
      hourRow.usd += rec.usd ?? 0
      hourRow.calls++
      hourRow.tokens += (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0)
    }
    const days = [...byDay.values()]
      .map((d) => ({ ...d, usd: roundCost(d.usd) }))
      .sort((a, b) => a.day.localeCompare(b.day))
    const hours = [...byHour.values()]
      .map((h) => ({ ...h, usd: roundCost(h.usd) }))
      .sort((a, b) => a.hour.localeCompare(b.hour))
    return { days, hours }
  }

  /** 24×7 heatmap (UTC hour × weekday) for the dashboard. */
  function heatmap(list, rangeDays) {
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0
    const grid = new Map()
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      const d = new Date(rec.time)
      const hour = d.getUTCHours()
      const weekday = d.getUTCDay()
      const key = `${weekday}:${hour}`
      let cell = grid.get(key)
      if (!cell) {
        cell = { weekday, hour, usd: 0, calls: 0 }
        grid.set(key, cell)
      }
      cell.usd += rec.usd ?? 0
      cell.calls++
    }
    const cells = []
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        const cell = grid.get(`${w}:${h}`)
        cells.push(cell
          ? { weekday: w, hour: h, usd: roundCost(cell.usd), calls: cell.calls }
          : { weekday: w, hour: h, usd: 0, calls: 0 })
      }
    }
    return cells
  }

  // ── HTTP API ──────────────────────────────────────────────────────────────
  // `webServer` is injected (see the plugin object above), so it is ready here.
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-bill/api',
    handler: async (req, res) => {
      const sendJson = (obj) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(obj))
      }
      try {
        await Promise.all([ensurePricingLoaded(), ensureFxLoaded()])
        const body = await readBody(req)
        const action = body?.action
        const fx = getFx()
        const base = { fx: fx.rates, fxSource: fx.source, unit: 'USD' }

        if (action === 'session-cost') {
          const sessionId = body.sessionId
          const list = sessionId ? (bySession.get(sessionId) ?? []).map((i) => records[i]) : []
          sendJson({ ...base, ...foldRecords(list), sessionId })
          return
        }
        if (action === 'overview') {
          // Two figures for the compact dock readout: current-session spend and
          // the all-time total. The browser renders them as two plain lines.
          const sessionId = body.sessionId
          const sessionList = sessionId ? (bySession.get(sessionId) ?? []).map((i) => records[i]) : []
          const session = foldRecords(sessionList)
          const total = foldRecords(records)
          sendJson({
            ...base,
            sessionId,
            sessionUsd: session.totalUsd,
            sessionCalls: session.calls,
            totalUsd: total.totalUsd,
            totalCalls: total.calls,
            // Peak split of THIS session — the dock line reports what the
            // current conversation is paying, not the all-time average.
            peakUsd: session.peakUsd,
            offPeakUsd: session.offPeakUsd,
            peakCalls: session.peakCalls,
            offPeakCalls: session.offPeakCalls,
          })
          return
        }
        if (action === 'dashboard') {
          const rangeDays = Number.isFinite(Number(body.rangeDays)) ? Number(body.rangeDays) : 30
          const folded = foldRecords(records)
          const tl = timeline(records, rangeDays)
          const hm = heatmap(records, rangeDays)
          sendJson({
            ...base,
            rangeDays,
            ...folded,
            timelineDays: tl.days,
            timelineHours: tl.hours,
            heatmap: hm,
            attribution: attribution(records, rangeDays),
            perDayUsd: roundCost(folded.totalUsd / Math.max(1, rangeDays)),
          })
          return
        }
        if (action === 'fx') {
          sendJson({ ...base, ok: true })
          return
        }
        if (action === 'ping') {
          sendJson({ ...base, ok: true, records: records.length })
          return
        }
        sendJson({ ...base, ok: false, error: 'unknown action' })
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) })
      }
    },
  })

  // ── lifecycle ─────────────────────────────────────────────────────────────
  loadPersisted().finally(() => Promise.all([ensurePricingLoaded(), ensureFxLoaded()])).catch(() => {})
  },
}

/** Read a JSON request body (small); empty body → {} . */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!data.trim()) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}
