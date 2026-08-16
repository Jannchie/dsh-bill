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
  ensureFxLoaded, ensurePricingLoaded, getFx, mergeOverrides, offPeakRatesFor,
  peakStateFor, priceRecord as priceWithCatalog, ratesFor, roundCost,
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
  // `webServer` is required — without the HTTP carrier there is nothing to
  // display. `tools` is optional: a headless profile has no tool registry, and
  // the agent-facing query is a bonus, not a reason to fail to load.
  inject: { required: ['webServer'], optional: ['tools'] },
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
      // What the call was for. Ordinary conversation turns leave `purpose`
      // unset; the loop stamps 'compaction' / 'session-title' on the auxiliary
      // calls, which cost real money and are otherwise invisible — a long
      // session's compactions can outweigh the turns that triggered them.
      purpose: options?.purpose ?? 'agent',
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
    // Overhead the loop spends on its own behalf — compaction and session
    // titles — kept apart from the turns the user actually asked for.
    const byPurpose = new Map()
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
      const purpose = rec.purpose ?? 'agent'
      const pRow = byPurpose.get(purpose) ?? { purpose, usd: 0, calls: 0 }
      pRow.usd += rec.usd ?? 0
      pRow.calls++
      byPurpose.set(purpose, pRow)
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
      byPurpose: [...byPurpose.values()]
        .map((row) => ({ ...row, usd: roundCost(row.usd) }))
        .sort((a, b) => b.usd - a.usd),
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

  /**
   * Spend rate and what peak hours are costing.
   *
   * The projection divides by the number of days actually OBSERVED, not by the
   * requested range: a 30-day window holding two days of history would
   * otherwise report a daily average 15x too low and forecast accordingly.
   *
   * `peakExtraUsd` re-prices every peak-window call at the same period's
   * off-peak rates and takes the difference — the real, already-paid premium
   * for when the work ran, not a share of the bill. It only exists for models
   * that bill peak/off-peak at all (DeepSeek's first-party API today).
   */
  function forecast(list, rangeDays) {
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0
    const days = new Set()
    let first = Infinity
    let last = 0
    let usd = 0
    let peakUsd = 0
    let peakExtraUsd = 0
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      usd += rec.usd ?? 0
      days.add(new Date(rec.time).toISOString().slice(0, 10))
      if (rec.time < first) first = rec.time
      if (rec.time > last) last = rec.time
      if (rec.peak !== 'peak') continue
      peakUsd += rec.usd ?? 0
      const offPeak = offPeakRatesFor(rec.model, rec.time)
      const paid = ratesFor(rec.model, rec.time)
      if (!offPeak || !paid || !(rec.usd > 0)) continue
      // Same tokens, cheap-window card. Ratio rather than a re-run of the
      // full cost function: the record's stored cost is the ground truth and
      // the token mix is already baked into it.
      const tokens = {
        input: (rec.inputTokens ?? 0),
        read: (rec.cacheReadTokens ?? 0),
        write: (rec.cacheWriteTokens ?? 0),
        out: (rec.outputTokens ?? 0),
      }
      const at = (r) => tokens.input * r.inputCostPerToken
        + tokens.read * r.cacheReadInputCostPerToken
        + tokens.write * r.cacheCreationInputCostPerToken
        + tokens.out * r.outputCostPerToken
      const paidUsd = at(paid)
      const cheapUsd = at(offPeak)
      if (paidUsd > 0 && cheapUsd < paidUsd) peakExtraUsd += (paidUsd - cheapUsd) / paidUsd * rec.usd
    }
    // Span the history actually covers, so one busy day does not read as a
    // sustained daily rate.
    const spanDays = last > first ? Math.max(1, Math.ceil((last - first) / 86400000)) : days.size || 0
    const observedDays = Math.max(days.size, spanDays)
    const perDayUsd = observedDays > 0 ? usd / observedDays : 0
    return {
      observedDays,
      activeDays: days.size,
      perDayUsd: roundCost(perDayUsd),
      per30dUsd: roundCost(perDayUsd * 30),
      peakExtraUsd: roundCost(peakExtraUsd),
      peakUsd: roundCost(peakUsd),
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

  // ── agent-facing tool ─────────────────────────────────────────────────────
  //
  // Lets the model answer "how much has this cost?" in-conversation instead of
  // making the user open a settings page and read it back.
  const tools = ctx.get('tools')
  if (tools && typeof tools.register === 'function') {
    // Imported lazily so a profile without dsh-tools never resolves it.
    import('@deepseek-ai/dsh-tools').then(({ defineTool }) => {
      ctx.effect(() => tools.register(defineTool({
        name: 'bill_stats',
        description: 'Query this machine\'s recorded LLM spend: totals, per-model breakdown, '
          + 'peak/off-peak split, loop overhead (compaction), and a 30-day projection. '
          + 'All amounts are USD. Optionally scope to one session or a number of days.',
        parameters: {
          type: 'object',
          properties: {
            rangeDays: { type: 'number', description: 'How many days back to include. Default 30; 0 means all history.' },
            sessionId: { type: 'string', description: 'Restrict to one session id. Omit for every session.' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              totalUsd: { type: 'number' },
              calls: { type: 'number' },
              byModel: { type: 'array', items: { type: 'object', additionalProperties: true } },
              byPurpose: { type: 'array', items: { type: 'object', additionalProperties: true } },
              forecast: { type: 'object', additionalProperties: true },
              attribution: { type: 'object', additionalProperties: true },
            },
            additionalProperties: true,
          },
          // The model reads the one-line summary; the structured body stays
          // available for follow-up questions without another call.
          render: (args, value) => [{ type: 'text', text: value?.summary ?? JSON.stringify(value) }],
        },
        execute: async (args) => {
          await Promise.all([ensurePricingLoaded(), ensureFxLoaded()])
          const rangeDays = Number.isFinite(Number(args?.rangeDays)) ? Number(args.rangeDays) : 30
          const since = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0
          const list = args?.sessionId
            ? (bySession.get(args.sessionId) ?? []).map((i) => records[i])
            : records
          const scoped = list.filter((rec) => rec.time >= since)
          const folded = foldRecords(scoped)
          const fc = forecast(scoped, rangeDays)
          const scope = args?.sessionId ? `session ${args.sessionId}` : 'all sessions'
          const window = rangeDays > 0 ? `last ${rangeDays} days` : 'all time'
          const top = folded.byModel.slice(0, 3)
            .map((row) => `${row.displayName ?? row.model} $${row.usd}`).join(', ')
          const summary = [
            `$${folded.totalUsd} across ${folded.calls} calls (${scope}, ${window}).`,
            top ? `Top models: ${top}.` : '',
            fc.per30dUsd > 0 ? `At the observed rate that is ~$${fc.per30dUsd}/30d.` : '',
            fc.peakExtraUsd > 0 ? `$${fc.peakExtraUsd} of it is the peak-hour premium.` : '',
            folded.priced ? '' : 'Some calls used models with no listed price and are excluded.',
          ].filter(Boolean).join(' ')
          return {
            summary,
            totalUsd: folded.totalUsd,
            calls: folded.calls,
            byModel: folded.byModel,
            byPurpose: folded.byPurpose,
            forecast: fc,
            attribution: attribution(scoped, rangeDays),
          }
        },
      })), 'dsh-bill: bill_stats tool')
    }).catch(() => { /* no tool registry available; the UI still works */ })
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
            forecast: forecast(records, rangeDays),
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
