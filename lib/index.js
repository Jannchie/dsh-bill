/**
 * Host half of dsh-bill.
 *
 * Captures every model call through the `llm/stream` waterfall, prices it
 * immediately at its own timestamp (via `llm-pricing`: models.dev + OpenRouter
 * catalogues, DeepSeek peak/off-peak schedules, user overrides), keeps a
 * bounded in-memory ring, and persists to `$DSH_HOME/dsh-bill/records.jsonl`
 * (default `~/.dsh/...`, cwd-independent).
 *
 * Three outward surfaces, each optional, each degrading to nothing:
 *
 *   - `ctx.connection.rpc` channel `/dsh-bill` — the transport-independent
 *     request path the browser half prefers.
 *   - `POST /dsh-bill/api` on `webServer` — the same dispatch over plain HTTP,
 *     for a client generation without the RPC channel.
 *   - the `billTurns` session projection — per-turn cost, PUSHED to the client
 *     rather than polled (see `./projection.js`).
 *
 * The action vocabulary is shared by the first two:
 *
 *   { action: 'session-cost', sessionId }  → one session's totals + per-model
 *   { action: 'dashboard', rangeDays? }    → global KPI / per-model / timeline
 *   { action: 'fx' }                       → effective USD→CNY rate
 *
 * All monetary values are returned in USD (the pricing basis); the browser
 * converts to the user's chosen display currency with the served fx rate, so
 * switching currencies is instant and identical across every component.
 *
 * Fail-soft contract: this plugin declares NO hard dependency. Recording spend
 * is useful on its own — through the `bill_stats` tool, or simply so the
 * history is there when a UI is next mounted — so a headless assembly with no
 * HTTP carrier keeps the capture path instead of waiting forever for a service
 * it does not need. Persistence goes to the harness home rather than through
 * the DSH `fs` service, which resolves against the workspace: spend is one
 * store per machine, not one per project.
 *
 * @module dsh-bill
 */

import { attributeCost, normalizeTo, segmentsOf } from './attribution.js'
import {
  appendFilePrivate, dshHomePath, hostkitReady, optionalHostImport, readFileOrNull,
  withFileLock, writeFileAtomic,
} from './hostkit.js'
import { billTurnsProjection } from './projection.js'
import {
  ensureFxLoaded, ensurePricingLoaded, getFx, mergeOverrides, offPeakRatesFor,
  peakStateFor, priceRecord as priceWithCatalog, ratesFor, roundCost,
} from './pricing.js'

/** Default in-memory ring cap; `maxRecords` in the plugin config overrides it. */
const DEFAULT_MAX_RECORDS = 20000

/** One config issue in the shape cordis's ValidationError renders. */
const issue = (message, ...path) => ({ message, path: path.length ? path : undefined })

/**
 * Plugin config, as a Standard Schema.
 *
 * Cordis validates `plugin.Config` through `Config['~standard'].validate()`
 * before the fiber starts, and hands `apply` whatever comes back — so a schema
 * is both the place bad config is REFUSED (with the offending path named,
 * instead of a `NaN` surfacing three layers down as a silently empty report)
 * and the place defaults are materialized. Written by hand against the
 * Standard Schema spec rather than with schemastery: this package would
 * otherwise take a dependency on a host-profile package for one object (see
 * `hostkit.js` for why that import is not reliably available).
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-bill',
    validate(input) {
      // The Loader passes `undefined` for a config-less row.
      if (input === undefined || input === null) return { value: { maxRecords: DEFAULT_MAX_RECORDS } }
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [issue('expected an object')] }
      }
      const issues = []
      const value = {}

      const { maxRecords } = input
      if (maxRecords === undefined) value.maxRecords = DEFAULT_MAX_RECORDS
      else if (typeof maxRecords !== 'number' || !Number.isInteger(maxRecords) || maxRecords <= 0) {
        issues.push(issue('expected a positive integer', 'maxRecords'))
      } else value.maxRecords = maxRecords

      const { priceOverrides } = input
      if (priceOverrides !== undefined) {
        if (typeof priceOverrides !== 'object' || priceOverrides === null || Array.isArray(priceOverrides)) {
          issues.push(issue('expected an object keyed by model id', 'priceOverrides'))
        } else {
          for (const [model, override] of Object.entries(priceOverrides)) {
            if (typeof override !== 'object' || override === null) {
              issues.push(issue('expected an object', 'priceOverrides', model))
              continue
            }
            // Per-million USD. An entry missing either side cannot price a
            // call, and silently dropping it is how a model ends up reported
            // as unpriced with no indication that the config meant to fix it.
            for (const field of ['inputPerM', 'outputPerM']) {
              if (!(Number(override[field]) >= 0)) {
                issues.push(issue('required, in USD per million tokens', 'priceOverrides', model, field))
              }
            }
          }
          value.priceOverrides = priceOverrides
        }
      }

      return issues.length ? { issues } : { value }
    },
  },
}

/**
 * Cordis plugin entry.
 *
 * `inject` is deliberately EMPTY. A hard dependency makes cordis hold the
 * whole fiber until the service resolves, which is right for something that
 * cannot work without it and wrong here: recording spend needs no carrier, and
 * an assembly with no `webServer` (headless, a remote host, a non-HTTP client)
 * would otherwise install this plugin and have it do nothing at all — not even
 * keep the history it exists to keep.
 *
 * Nor is a bare `ctx.get('webServer')` probe the alternative: the carrier is a
 * Service that may not have initialized when `apply` runs, and probing it here
 * silently skips the route (the observed failure was POSTs to /dsh-bill/api
 * falling through to the SPA fallback and returning 405). Every optional
 * carrier is therefore mounted through `ctx.inject([...], ...)`, which waits
 * for the service in a CHILD fiber — the route registers exactly when the
 * carrier is ready, and its absence costs nothing but the route.
 */
export default {
  name: 'dsh-bill',
  Config,
  inject: [],
  apply(ctx, config = null) {
    // Shape and defaults are `Config`'s job — cordis runs it before this
    // fiber starts. Re-deriving them here would put the default in two places
    // and, worse, in two different forms (this used to coerce with `Number()`,
    // which the schema explicitly rejects). The `?? {}` covers only the direct
    // caller that bypasses the loader: a test.
    const cfg = config ?? {}
    mergeOverrides(cfg.priceOverrides)

  /**
   * In-memory ring cap. Configurable mostly so the eviction path — otherwise
   * unreachable until a few months of use — can be exercised by a test rather
   * than trusted.
   */
  const maxRecords = cfg.maxRecords ?? DEFAULT_MAX_RECORDS

  /** In-memory ring of call records. */
  let records = []
  /** Map sessionId → its call indices into `records` (for session-cost). */
  const bySession = new Map()
  let recordSeq = 0
  /**
   * Bumped whenever the ring's contents change (append, eviction, load).
   * Everything derived from `records` is memoised against it — unlike
   * `records.length`, it also moves when a push and an eviction cancel out.
   */
  let ringVersion = 0

  /** Memoised aggregations, valid for one `ringVersion`. */
  const dashboardCache = new Map()
  let allTimeCache = null

  /** Serialized persistence queue (fs writes are ordered and best-effort). */
  let persistQueue = Promise.resolve()
  /** Records already appended to the file, so ordinary calls never rewrite it. */
  let persistedCount = 0
  /** Set when the file can no longer be reconciled by appending. */
  let persistRewrite = true
  /** Suppresses writes until the startup read has finished (see loadPersisted). */
  let loading = true

  // ── accumulation ──────────────────────────────────────────────────────────
  //
  // One shape, three producers: a range fold, the live-plus-forgotten fold, and
  // the rollup itself. They used to be three hand-written copies of the same
  // additions, which meant a new token bucket had to be added in three places
  // or it silently under-reported in whichever one was missed.

  /** Fields summed across whole accumulators. */
  const TOTAL_FIELDS = [
    'calls', 'usd', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'outputTokens', 'peakUsd', 'offPeakUsd', 'peakCalls', 'offPeakCalls',
  ]
  /** Fields summed across per-model rows. */
  const MODEL_FIELDS = [
    'usd', 'calls', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'peakUsd', 'offPeakUsd',
  ]

  const emptyFold = () => ({
    calls: 0,
    usd: 0,
    priced: true,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    // Peak/off-peak split, over the records whose model actually has a peak
    // schedule (DeepSeek first-party). Records on flat-priced models are
    // counted in neither, so the share is a share of what peak pricing could
    // apply to, not of the whole bill.
    peakUsd: 0,
    offPeakUsd: 0,
    peakCalls: 0,
    offPeakCalls: 0,
    byModel: {},
    // Overhead the loop spends on its own behalf — compaction and session
    // titles — kept apart from the turns the user actually asked for.
    byPurpose: {},
  })

  /** Add one priced record to an accumulator. */
  function foldOne(acc, rec) {
    const usd = rec.usd ?? 0
    acc.calls++
    if (rec.usd === null) acc.priced = false
    else acc.usd += usd
    acc.uncachedInputTokens += rec.inputTokens ?? 0
    acc.cacheReadTokens += rec.cacheReadTokens ?? 0
    acc.cacheWriteTokens += rec.cacheWriteTokens ?? 0
    acc.outputTokens += rec.outputTokens ?? 0
    if (rec.peak === 'peak') { acc.peakUsd += usd; acc.peakCalls++ }
    else if (rec.peak === 'offpeak') { acc.offPeakUsd += usd; acc.offPeakCalls++ }

    const key = `${rec.provider ?? 'unknown'}/${rec.model ?? 'unknown'}`
    const row = acc.byModel[key] ?? (acc.byModel[key] = {
      provider: rec.provider, model: rec.model, displayName: rec.displayName, base: rec.base,
      usd: 0, priced: true, calls: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, peakUsd: 0, offPeakUsd: 0,
    })
    row.usd += usd
    if (rec.usd === null) row.priced = false
    row.calls++
    row.inputTokens += rec.inputTokens ?? 0
    row.outputTokens += rec.outputTokens ?? 0
    row.cacheReadTokens += rec.cacheReadTokens ?? 0
    row.cacheWriteTokens += rec.cacheWriteTokens ?? 0
    if (rec.peak === 'peak') row.peakUsd += usd
    else if (rec.peak === 'offpeak') row.offPeakUsd += usd

    const purpose = rec.purpose ?? 'agent'
    const pRow = acc.byPurpose[purpose] ?? (acc.byPurpose[purpose] = { purpose, usd: 0, calls: 0 })
    pRow.usd += usd
    pRow.calls++
  }

  /** Add every total in `source` into `target` (used to fold the rollup in). */
  function mergeFold(target, source) {
    if (!source || source.calls === 0) return target
    for (const field of TOTAL_FIELDS) target[field] += source[field] ?? 0
    if (!source.priced) target.priced = false
    for (const [key, row] of Object.entries(source.byModel)) {
      const live = target.byModel[key]
      if (!live) { target.byModel[key] = { ...row }; continue }
      for (const field of MODEL_FIELDS) live[field] += row[field] ?? 0
      if (!row.priced) live.priced = false
    }
    for (const [purpose, row] of Object.entries(source.byPurpose)) {
      const live = target.byPurpose[purpose] ?? (target.byPurpose[purpose] = { purpose, usd: 0, calls: 0 })
      live.usd += row.usd
      live.calls += row.calls
    }
    return target
  }

  // Day and hour buckets share one definition so a chart and the rollup that
  // feeds it can never disagree about what "tokens" in a bucket means.
  const dayKeyOf = (time) => new Date(time).toISOString().slice(0, 10)

  /** Add one record to a `{key: {usd, calls, tokens}}` bucket map. */
  function addBucket(buckets, key, label, rec) {
    const row = buckets[key] ?? (buckets[key] = { ...label, usd: 0, calls: 0, tokens: 0 })
    row.usd += rec.usd ?? 0
    row.calls++
    row.tokens += (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0)
  }

  /** Add a whole bucket (from the rollup) into a bucket map. */
  function mergeBucket(buckets, key, row) {
    const live = buckets[key]
    if (!live) { buckets[key] = { ...row }; return }
    live.usd += row.usd
    live.calls += row.calls
    live.tokens += row.tokens
  }

  /**
   * Everything the ring has already forgotten.
   *
   * The in-memory ring is bounded, so at a few hundred calls a day it starts
   * evicting after a couple of months. Dropping those records silently would
   * make "total spend" go DOWN over time, which is the one thing a number by
   * that name must never do. So a record is folded into this accumulator on
   * its way out: the per-call detail (and its attribution) is gone, but every
   * total it contributed to survives.
   *
   * `fileSkip` makes this file the transaction log for eviction: it counts the
   * leading lines of records.jsonl that have already been folded in here. Both
   * halves land in one atomic write, so a crash can never fold a record and
   * forget to skip it (double-counting it at load) or the reverse.
   */
  const emptyRollup = () => ({ ...emptyFold(), byDay: {}, attr: {}, fileSkip: 0 })
  let rollup = emptyRollup()

  /** Fold one evicted record into the rollup. Never reversible — by design. */
  function foldIntoRollup(rec) {
    priceRecord(rec)
    foldOne(rollup, rec)
    const day = dayKeyOf(rec.time)
    addBucket(rollup.byDay, day, { day }, rec)
    for (const [key, usd] of Object.entries(rec.attr ?? {})) {
      rollup.attr[key] = (rollup.attr[key] ?? 0) + usd
    }
  }

  /**
   * Drop the oldest `count` records, folding them into the rollup first.
   *
   * The single door out of the ring — eviction that skipped this would be
   * exactly the silent-shrink bug the rollup exists to prevent. It also owns
   * the session index, which indexes into `records` and is invalid the instant
   * the splice lands.
   */
  function evictOldest(count) {
    if (count <= 0) return
    const evicted = Math.min(count, records.length)
    for (let i = 0; i < evicted; i++) foldIntoRollup(records[i])
    records.splice(0, evicted)
    ringVersion++
    rebuildSessionIndex()
    // The evicted lines stay in the file as dead weight rather than forcing an
    // O(n) rewrite per call once the ring is full — which is exactly when the
    // rewrite is most expensive. The file is compacted when the dead prefix
    // has grown to the size of the ring itself.
    // Only lines that actually reached the file become a dead prefix. A record
    // evicted before its append ran was never written at all — it lives on in
    // the rollup, and counting it here would skip a live record at load.
    const onDisk = Math.min(evicted, persistedCount)
    rollup.fileSkip += onDisk
    persistedCount -= onDisk
    if (rollup.fileSkip > maxRecords) persistRewrite = true
    persistRollup()
  }

  /** Set while a rollup write is queued but has not yet serialized the state. */
  let rollupQueued = false

  /**
   * Publish the rollup.
   *
   * Under the lock because this is the one true read-modify-write in the
   * plugin: two dsh processes sharing a `$DSH_HOME` each read a rollup, each
   * fold their own evictions into it, and — unlocked — the second rename
   * discards the first one's folded records outright. The lock covers the
   * whole cycle, so the loser waits and folds into the winner's result.
   *
   * Coalesced, because once the ring is full EVERY recorded call evicts one
   * record and asks for a write. Queuing each of them would mean a lock cycle
   * (create, write, rename, unlink) per model call, and — since the record
   * appends share this queue — a peer holding the lock would stall those
   * appends behind up to `LOCK_TIMEOUT_MS` of waiting, once per eviction. A
   * write already queued has not serialized yet, so it will carry whatever the
   * rollup has become by the time it runs; a second one would write the same
   * bytes again. Coalescing loses nothing: the rollup is written from live
   * state, not from a snapshot taken when the request was made.
   */
  function persistRollup() {
    if (loading || rollupQueued) return
    rollupQueued = true
    persistQueue = persistQueue
      .then(() => {
        rollupQueued = false
        const file = rollupFile()
        // Serialized INSIDE the queued task, so a coalesced burst publishes
        // the final state rather than the state at the first request.
        const text = JSON.stringify(rollup)
        return withFileLock(file, () => writeFileAtomic(file, text))
      })
      .catch(() => { rollupQueued = false })
  }

  async function loadRollup() {
    try {
      const text = await readFileOrNull(rollupFile())
      if (text === null) return
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') rollup = { ...emptyRollup(), ...parsed }
    } catch { /* unreadable or malformed: start from an empty rollup */ }
  }

  /**
   * Global data file under the harness home (`$DSH_HOME`, else `~/.dsh`) —
   * NOT relative to the session cwd. The DSH `fs` service resolves paths
   * against the workspace, which would scatter records per project and change
   * with the working directory; a fixed home-relative file is the stable,
   * single-store location (mirrors how dsh itself keeps settings/storages).
   * The home itself is resolved by `hostkit`, which borrows DSH's own resolver
   * when it is reachable rather than restating its precedence rules here.
   */
  const recordsFile = () => dshHomePath('dsh-bill', 'records.jsonl')

  const rollupFile = () => dshHomePath('dsh-bill', 'rollup.json')

  /**
   * Where records lived before the plugin was renamed from `dsh-cost-money`.
   *
   * Read once at startup when the current file does not exist yet, so a rename
   * does not look like "all my history is gone". The old file is left in place
   * rather than moved or deleted: the first write lands in the new location,
   * and an untouched backup costs nothing.
   */
  const legacyRecordsFile = () => dshHomePath('dsh-cost-money', 'records.jsonl')

  /** Load persisted records at startup (best effort — never fatal). */
  async function loadPersisted() {
    try {
      const text = await readFileOrNull(recordsFile()) ?? await readFileOrNull(legacyRecordsFile())
      if (text === null) return
      const history = []
      let line = 0
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        // The leading lines the rollup has already absorbed. Skipping by count
        // rather than by timestamp keeps the merge exact even when a backfill
        // has inserted records older than anything else in the file.
        if (line++ < rollup.fileSkip) continue
        try { history.push(JSON.parse(raw)) } catch { /* skip malformed line */ }
      }
      if (history.length === 0) return
      // Calls captured while this read was in flight are held in `records`;
      // `persist()` is suppressed until we are done, so the file cannot also
      // contain them and the concatenation is exact.
      records = history.concat(records)
      // Anything beyond the ring is folded rather than dropped, so a file
      // that outgrew the cap still contributes its totals.
      if (records.length > maxRecords) evictOldest(records.length - maxRecords)
      backfillPeak()
      rebuildSessionIndex()
      ringVersion++
      // Memory is now the union of the file and the startup window, so the
      // next write reconciles both with a rewrite.
      persistRewrite = true
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

  /**
   * Write the ring to the JSONL file (ordered through a queue).
   *
   * The file is append-only in the common case. Rewriting all of it on every
   * captured call is O(n) per call: at a full ring that is ~10 MB of write
   * amplification for one new line, and it grows with the history it is
   * supposed to be cheap to keep. Eviction does not force a rewrite either —
   * it leaves the evicted lines in place and records how many to skip — so the
   * append path keeps working after the ring fills, which is when it matters.
   * A full rewrite happens only when the dead prefix has grown to the size of
   * the ring, or when a backfill has resorted the whole thing.
   */
  function persist() {
    if (loading) return
    // Read the intent here, not inside the async body: an eviction landing
    // while a write is in flight would otherwise have its rewrite request
    // cleared by that write, leaving the file reconciled by an append it
    // cannot be reconciled by.
    const rewrite = persistRewrite
    persistRewrite = false
    persistQueue = persistQueue.then(async () => {
      const file = recordsFile()
      // Everything this task records about the file is derived BEFORE the write
      // and applied as a delta. Calls keep arriving during the await, so reading
      // `records.length` afterwards credits the file with records it does not
      // contain — and they are then skipped forever.
      if (!rewrite) {
        const fresh = records.slice(persistedCount)
        if (fresh.length === 0) return
        const text = fresh.map((r) => JSON.stringify(r)).join('\n') + '\n'
        persistedCount += fresh.length
        try {
          // Unlocked on purpose: an append is not a read-modify-write, and
          // POSIX makes a single small `O_APPEND` write atomic, so two writers
          // interleave whole lines rather than corrupting each other's.
          await appendFilePrivate(file, text)
        } catch (error) {
          persistedCount = Math.max(0, persistedCount - fresh.length)
          throw error
        }
        return
      }
      const count = records.length
      const skipBefore = rollup.fileSkip
      const text = count === 0 ? '' : records.map((r) => JSON.stringify(r)).join('\n') + '\n'
      // A rewrite replaces the whole file, so it takes the lock: an append
      // landing between this read of the ring and the rename would otherwise
      // be erased with no trace.
      await withFileLock(file, () => writeFileAtomic(file, text))
      // The file now starts at the ring's first record — except for whatever
      // was evicted while the write was in flight, whose lines are inside what
      // was just written and are a dead prefix of it.
      rollup.fileSkip -= skipBefore
      persistedCount = Math.max(0, count - rollup.fileSkip)
      persistRollup()
    }).catch(() => {
      // Persistence is best-effort, but a dropped rewrite is not: without it
      // the next append would extend a file that no longer matches the ring.
      if (rewrite) persistRewrite = true
    })
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
    ringVersion++
    if (records.length > maxRecords) {
      // Eviction reindexes the whole ring (the indices below it just shifted).
      evictOldest(records.length - maxRecords)
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
  /**
   * The earliest timestamp a range covers; 0 for "all time".
   *
   * Every aggregator takes `rangeDays` and derives its own bound from this, so
   * the range convention (and what a non-positive value means) lives in one
   * place rather than at each call site.
   */
  const sinceOf = (rangeDays) => (rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0)

  /**
   * Per-model fold of a record subset (all amounts USD).
   *
   * `withRollup` folds in what the ring has already forgotten. It belongs to
   * whole-history scopes only — a session or a date range must not inherit
   * totals from records it never contained.
   */
  function foldRecords(list, rangeDays = 0, withRollup = false) {
    const since = sinceOf(rangeDays)
    const acc = emptyFold()
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      foldOne(acc, rec)
    }
    if (withRollup) mergeFold(acc, rollup)
    return {
      calls: acc.calls,
      tokens: acc.uncachedInputTokens + acc.outputTokens,
      uncachedInputTokens: acc.uncachedInputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
      outputTokens: acc.outputTokens,
      totalUsd: roundCost(acc.usd),
      peakUsd: roundCost(acc.peakUsd),
      offPeakUsd: roundCost(acc.offPeakUsd),
      peakCalls: acc.peakCalls,
      offPeakCalls: acc.offPeakCalls,
      priced: acc.priced,
      byModel: Object.values(acc.byModel)
        .map((row) => ({
          ...row,
          usd: roundCost(row.usd),
          peakUsd: roundCost(row.peakUsd),
          offPeakUsd: roundCost(row.offPeakUsd),
          base: row.base ?? null,
        }))
        .sort((a, b) => b.usd - a.usd),
      byPurpose: Object.values(acc.byPurpose)
        .map((row) => ({ ...row, usd: roundCost(row.usd) }))
        .sort((a, b) => b.usd - a.usd),
    }
  }

  /** All-time totals including the rollup, memoised for the dock's 8s poll. */
  function allTimeTotals() {
    if (allTimeCache && allTimeCache.version === ringVersion) return allTimeCache.value
    const value = foldRecords(records, 0, true)
    allTimeCache = { version: ringVersion, value }
    return value
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
    const since = sinceOf(rangeDays)
    const byCat = new Map()
    let attributedUsd = 0
    let totalUsd = 0
    let attributedCalls = 0
    let calls = 0
    // An attribution key is `category|detail`, with a bare key meaning the
    // category has no detail axis. Splitting it in one place keeps the live
    // records and the rollup reading the same convention.
    function addAttr(key, usd) {
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
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      calls++
      totalUsd += rec.usd ?? 0
      if (!rec.attr) continue
      attributedCalls++
      for (const [key, usd] of Object.entries(rec.attr)) addAttr(key, usd)
    }
    // Attribution the ring has forgotten. Only whole-history scopes get it —
    // a rollup entry has no timestamp finer than the day it was folded on.
    if (rangeDays <= 0) {
      for (const [key, usd] of Object.entries(rollup.attr)) addAttr(key, usd)
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
          // A flag and a count, not a sentence. This row used to carry the
          // Chinese label itself, which put one untranslated string in the
          // middle of the English report — and broke the rule the rest of this
          // file keeps, that the host stores ids (a storage format) and the
          // browser owns every word the user reads. `sub` stays a plain row
          // key; `folded` is what the client renders from.
          shown = children.slice(0, MAX_CHILDREN - 1).concat({
            sub: 'other',
            usd: rest.reduce((sum, c) => sum + c.usd, 0),
            folded: true,
            count: rest.length,
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
    const since = sinceOf(rangeDays)
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

  /**
   * Spend per session, most expensive first.
   *
   * A session is the unit a user actually recognises ("that refactor cost me
   * more than the whole week's chat"), which no per-model or per-day view
   * surfaces. Titles are not stored with records, so the browser resolves them
   * from its own session list — the host only knows ids.
   */
  function bySessionRows(list, rangeDays, limit = 8) {
    const since = sinceOf(rangeDays)
    const rows = new Map()
    for (const rec of list) {
      if (rec.time < since || !rec.sessionId) continue
      priceRecord(rec)
      const row = rows.get(rec.sessionId) ?? { sessionId: rec.sessionId, usd: 0, calls: 0, lastAt: 0 }
      row.usd += rec.usd ?? 0
      row.calls++
      if (rec.time > row.lastAt) row.lastAt = rec.time
      rows.set(rec.sessionId, row)
    }
    return [...rows.values()]
      .map((row) => ({ ...row, usd: roundCost(row.usd) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, limit)
  }

  /**
   * Spend over the periods a budget can be set against.
   *
   * Computed on the host from the same records the rest of the report uses, so
   * a budget bar can never disagree with the totals above it. Day and month
   * boundaries follow the HOST's local calendar: a budget is a human intention
   * about "this month", and the user's month is the one on their wall.
   */
  function periodTotals(list) {
    const now = new Date()
    const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`
    const today = dayKey(now)
    const month = monthKey(now)
    let dayUsd = 0
    let monthUsd = 0
    let allUsd = 0
    for (const rec of list) {
      priceRecord(rec)
      const usd = rec.usd ?? 0
      allUsd += usd
      const at = new Date(rec.time)
      if (monthKey(at) === month) {
        monthUsd += usd
        if (dayKey(at) === today) dayUsd += usd
      }
    }
    // The rollup's per-day buckets carry the forgotten records. Day and month
    // are host-local, so each bucket is tested against the local calendar.
    for (const [day, row] of Object.entries(rollup.byDay)) {
      const at = new Date(day + 'T12:00:00Z')
      allUsd += row.usd
      if (monthKey(at) === month) {
        monthUsd += row.usd
        if (dayKey(at) === today) dayUsd += row.usd
      }
    }
    return { day: roundCost(dayUsd), month: roundCost(monthUsd), all: roundCost(allUsd) }
  }

  /** Global timeline buckets (by day, then by hour) for the dashboard. */
  function timeline(list, rangeDays) {
    const since = sinceOf(rangeDays)
    const byDay = {}
    const byHour = {}
    for (const rec of list) {
      if (rec.time < since) continue
      priceRecord(rec)
      const day = dayKeyOf(rec.time)
      addBucket(byDay, day, { day }, rec)
      const hour = new Date(rec.time).toISOString().slice(0, 13)
      addBucket(byHour, hour, { hour }, rec)
    }
    // Days the ring no longer holds still belong on the chart.
    for (const [day, row] of Object.entries(rollup.byDay)) {
      if (new Date(day + 'T23:59:59Z').getTime() < since) continue
      mergeBucket(byDay, day, row)
    }
    const days = Object.values(byDay)
      .map((d) => ({ ...d, usd: roundCost(d.usd) }))
      .sort((a, b) => a.day.localeCompare(b.day))
    const hours = Object.values(byHour)
      .map((h) => ({ ...h, usd: roundCost(h.usd) }))
      .sort((a, b) => a.hour.localeCompare(b.hour))
    return { days, hours }
  }

  /** 24×7 heatmap (UTC hour × weekday) for the dashboard. */
  function heatmap(list, rangeDays) {
    const since = sinceOf(rangeDays)
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
  // making the user open the report and read it back.
  //
  // Mounted through `ctx.inject` for the same reason as the carriers below: a
  // bare `ctx.get('tools')` at apply time can run before the registry has
  // initialized and then silently register nothing.
  ctx.inject(['tools'], (child) => {
    // `defineTool` lives in a host-profile package, so it cannot be imported
    // statically here (see hostkit.js).
    optionalHostImport('@deepseek-ai/dsh-tools').then((mod) => {
      if (!mod?.defineTool) return
      const { defineTool } = mod
      child.effect(() => child.tools.register(defineTool({
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
          const list = args?.sessionId
            ? (bySession.get(args.sessionId) ?? []).map((i) => records[i])
            : records
          // Same scoping rule as the dashboard route, so the two answer the
          // same question identically — including the rollup on all-time.
          const folded = foldRecords(list, rangeDays, rangeDays <= 0)
          const fc = forecast(list, rangeDays)
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
            attribution: attribution(list, rangeDays),
          }
        },
      })), 'dsh-bill: bill_stats tool')
    })
  })

  // ── historical backfill ───────────────────────────────────────────────────
  //
  // Live capture only sees calls made after the plugin is installed, which
  // makes the report empty on day one. The durable session log has the rest:
  // per-step token counts, the model route, and a timestamp.
  //
  // What it does NOT have is the request body. No prompt, no tool results, no
  // system prompt — the log records the route and the provider's usage report,
  // nothing of what was sent. So cost and tokens backfill exactly, and content
  // attribution cannot be reconstructed at all. Backfilled records carry
  // `source: 'log'` so the report can be honest about which rows have neither
  // attribution nor a peak split derived from live data.
  //
  // Double counting is avoided structurally rather than with a marker file: a
  // session that already has ANY record is skipped wholesale. That makes the
  // pass idempotent across restarts, and errs toward undercounting a session
  // that was mid-flight at install time rather than billing it twice.
  const BACKFILL_TIMEOUT_MS = 20000

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms)),
    ])
  }

  /** Pull the usage samples out of one session's event log. */
  function samplesFromEvents(events) {
    const samples = new Map()
    let provider = 'unknown'
    let model = 'unknown'
    for (const ev of events ?? []) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'request/header') {
        const cfg = ev.data?.header?.config
        if (typeof cfg?.model === 'string' && cfg.model) model = cfg.model
        if (typeof cfg?.provider === 'string' && cfg.provider) provider = cfg.provider
        continue
      }
      // A step reports usage twice — once as a streaming chunk, once on the
      // finalized message. Keying on turn:step and replacing makes the later,
      // more complete report win instead of doubling the step.
      const usage = ev.type === 'assistant/message'
        ? ev.data?.usage
        : ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage'
          ? ev.data.chunk.usage
          : undefined
      if (!usage) continue
      const key = `${ev.data?.turn ?? '?'}:${ev.data?.step ?? '?'}`
      const source = ev.data?.message?.source
      samples.set(key, {
        time: typeof ev.time === 'number' ? ev.time : Date.now(),
        provider: typeof source?.provider === 'string' ? source.provider : provider,
        model: typeof source?.model === 'string' ? source.model : model,
        usage,
      })
    }
    return [...samples.values()]
  }

  /** Import every session that has no records yet. Best effort, never fatal. */
  async function backfillFromLog() {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return
    let listed
    try {
      listed = await withTimeout(sessionQuery.listSessions(), BACKFILL_TIMEOUT_MS, 'listSessions')
    } catch { return }
    let imported = 0
    for (const entry of Array.isArray(listed) ? listed : []) {
      const id = typeof entry?.header?.id === 'string' ? entry.header.id : undefined
      if (!id || bySession.has(id)) continue
      let snapshot
      try {
        snapshot = await withTimeout(sessionQuery.readSession(id), BACKFILL_TIMEOUT_MS, 'readSession')
      } catch { continue }
      for (const sample of samplesFromEvents(snapshot?.events)) {
        const rec = priceRecord({
          seq: recordSeq++,
          time: sample.time,
          sessionId: id,
          provider: sample.provider,
          model: sample.model,
          inputTokens: sample.usage.inputTokens ?? 0,
          outputTokens: sample.usage.outputTokens ?? 0,
          cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0,
          reasoningTokens: sample.usage.reasoningTokens ?? 0,
          purpose: 'agent',
          source: 'log',
        })
        records.push(rec)
        imported++
      }
    }
    if (imported === 0) return
    // Chronological order keeps the timeline and the ring eviction sane.
    records.sort((a, b) => a.time - b.time)
    // The imported rows land throughout the ring, so the file can no longer be
    // reconciled by appending.
    persistRewrite = true
    ringVersion++
    if (records.length > maxRecords) evictOldest(records.length - maxRecords)
    rebuildSessionIndex()
    persist()
  }

  // ── account balance ───────────────────────────────────────────────────────
  //
  // Spend is only half the question; the other half is what is left. The key is
  // resolved and used HERE, on the host — the browser only ever sees the
  // resulting numbers, so a credential never reaches a page.
  //
  // Both services are optional probes rather than injects: a deployment with no
  // stored credentials, or one not on DeepSeek, should lose this readout and
  // keep the rest of the plugin.
  const BALANCE_TIMEOUT_MS = 15000

  async function readBalance() {
    const settings = ctx.get('settings')
    let apiKeyEnv = 'DEEPSEEK_API_KEY'
    let baseURL = 'https://api.deepseek.com'
    // Follow the llm-deepseek adapter's own configuration when present, so a
    // custom endpoint or key reference is picked up rather than guessed at.
    if (settings && typeof settings.get === 'function') {
      const cfg = settings.get('llm-deepseek')
      if (cfg && typeof cfg === 'object') {
        if (typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv) apiKeyEnv = cfg.apiKeyEnv
        if (typeof cfg.baseURL === 'string' && cfg.baseURL) baseURL = cfg.baseURL.replace(/\/+$/, '')
      }
    }
    const credentials = ctx.get('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') return { ok: false, reason: 'no-credentials' }
    const resolved = await credentials.resolve(apiKeyEnv)
    const key = resolved && typeof resolved.value === 'string' ? resolved.value : ''
    if (!key) return { ok: false, reason: 'no-key' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
    let response
    try {
      response = await fetch(baseURL + '/user/balance', {
        headers: { Authorization: 'Bearer ' + key },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) return { ok: false, reason: 'fetch-failed', status: response.status }
    const data = await response.json()
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
    // An account can carry several currencies, and the wire values are strings.
    const entry = infos.find((info) => info && info.currency === 'CNY') ?? infos[0]
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'fetch-failed' }
    const num = (value) => {
      const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
      return Number.isFinite(n) ? n : 0
    }
    return {
      ok: true,
      currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
      total: num(entry.total_balance),
      granted: num(entry.granted_balance),
      toppedUp: num(entry.topped_up_balance),
    }
  }

  // ── request dispatch ──────────────────────────────────────────────────────
  //
  // One function, two carriers. The browser half reaches it through the
  // Connection RPC channel when the client generation has one, and through the
  // HTTP route otherwise; both hand it the same `{ action, ... }` body and get
  // the same object back. Keeping the dispatch transport-free is what makes
  // the second carrier ~10 lines rather than a second copy of the report.
  async function handleAction(body) {
    await Promise.all([ensurePricingLoaded(), ensureFxLoaded()])
    const action = body?.action
    const fx = getFx()
    // Every amount below is USD; the browser converts with this table, so a
    // currency switch is instant and identical across every component.
    const base = { fx: fx.rates, fxSource: fx.source, unit: 'USD' }

    if (action === 'session-cost') {
      const sessionId = body.sessionId
      const list = sessionId ? (bySession.get(sessionId) ?? []).map((i) => records[i]) : []
      return { ...base, ...foldRecords(list), sessionId }
    }
    if (action === 'overview') {
      // Two figures for the compact dock readout: current-session spend and
      // the all-time total. The browser renders them as two plain lines.
      const sessionId = body.sessionId
      const sessionList = sessionId ? (bySession.get(sessionId) ?? []).map((i) => records[i]) : []
      const session = foldRecords(sessionList)
      const total = allTimeTotals()
      return {
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
      }
    }
    if (action === 'dashboard') {
      const rangeDays = Number.isFinite(Number(body.rangeDays)) ? Number(body.rangeDays) : 30
      // Seven passes over the ring per request, and more than one view can be
      // mounted at different ranges. Keyed by range so those views do not
      // evict each other, and stamped with the ring version plus a one-minute
      // bucket — a bounded range and the "today" totals both move with the
      // clock, so a machine sitting idle across midnight must not keep serving
      // yesterday's answer.
      const stamp = `${ringVersion}:${Math.floor(Date.now() / 60000)}`
      const cached = dashboardCache.get(rangeDays)
      if (cached && cached.stamp === stamp) return { ...base, ...cached.payload }
      // The rollup has no timestamp finer than a day and no per-model time
      // axis, so it joins the all-time view only. A bounded range reports
      // what the ring still holds, and says so when that is not everything.
      const folded = foldRecords(records, rangeDays, rangeDays <= 0)
      const tl = timeline(records, rangeDays)
      const hm = heatmap(records, rangeDays)
      const payload = {
        rangeDays,
        ...folded,
        timelineDays: tl.days,
        timelineHours: tl.hours,
        heatmap: hm,
        attribution: attribution(records, rangeDays),
        forecast: forecast(records, rangeDays),
        periods: periodTotals(records),
        // What the range asked for versus what the ring can still answer.
        archived: rollup.calls > 0 ? { calls: rollup.calls } : null,
        bySession: bySessionRows(records, rangeDays),
        perDayUsd: roundCost(folded.totalUsd / Math.max(1, rangeDays)),
      }
      // `rangeDays` comes off the wire, so the map is bounded by hand
      // rather than trusting callers to stick to the six ranges the UI
      // offers.
      if (dashboardCache.size > 16) dashboardCache.clear()
      dashboardCache.set(rangeDays, { stamp, payload })
      return { ...base, ...payload }
    }
    if (action === 'periods') {
      // Day / month / all-time spend and nothing else. The budget bar and the
      // sidebar line need exactly these, and asking `dashboard` for them made
      // the two cheapest surfaces in the plugin the most expensive requests:
      // a full timeline, heatmap, attribution tree, forecast and per-session
      // table built over the whole ring, then discarded.
      return { ...base, periods: periodTotals(records) }
    }
    if (action === 'balance') {
      try {
        return { ...base, balance: await readBalance() }
      } catch (error) {
        return { ...base, balance: { ok: false, reason: 'fetch-failed', message: error?.message } }
      }
    }
    if (action === 'fx') return { ...base, ok: true }
    if (action === 'ping') return { ...base, ok: true, records: records.length }
    return { ...base, ok: false, error: 'unknown action' }
  }

  // ── carriers ──────────────────────────────────────────────────────────────
  //
  // Each is mounted in its own child fiber through `ctx.inject`, so it waits
  // for its service to initialize (a bare `ctx.get` here runs before the
  // carrier is ready and silently registers nothing) and an assembly missing
  // that service simply never starts the child.

  // Connection RPC — the preferred path. It rides whatever transport the
  // client generation is already using rather than assuming HTTP, carries the
  // caller's AbortSignal, and is fenced to a loopback page authority: this
  // channel serves a complete record of what the machine has spent, which is
  // not something a remote origin should be able to ask for.
  ctx.inject(['connection'], (child) => {
    child.effect(() => {
      const dispose = child.connection.rpc.handle(
        '/dsh-bill',
        async (endpoint, payload) => {
          try {
            return { ok: true, value: await handleAction({ ...payload, action: endpoint }) }
          } catch (error) {
            return {
              ok: false,
              error: { code: 'internal', message: error?.message ?? String(error), details: {} },
            }
          }
        },
        { authority: 'loopback' },
      )
      // The registry's disposer is async; cordis only needs it started.
      return () => { void dispose() }
    }, 'dsh-bill: rpc channel')
  })

  // Plain HTTP — the compatibility path, and the one a browser can hit with a
  // bare fetch (useful for `curl`ing the numbers out of a script).
  ctx.inject(['webServer'], (child) => {
    child.webServer.register({
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
          sendJson(await handleAction(await readBody(req)))
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) })
        }
      },
    })
  })

  // Per-turn cost, folded from the durable session log and pushed to the
  // client. See ./projection.js for why this is a second source of truth
  // rather than a duplicate of the capture path.
  ctx.inject(['sessionProjections'], (child) => {
    child.sessionProjections.register(billTurnsProjection)
  })

  // ── lifecycle ─────────────────────────────────────────────────────────────
  // `hostkitReady` first: it decides whether the borrowed home resolver is in
  // charge, and every path below is computed from it.
  hostkitReady
    .then(() => loadRollup())
    .then(() => loadPersisted())
    // Capture is live from the moment apply() returns, so calls can land while
    // the read above is still in flight. Writes stay suppressed until it has
    // finished, which keeps the file free of the records held in memory and
    // makes the merge in loadPersisted a plain concatenation.
    .then(() => { loading = false; persist() })
    .then(() => Promise.all([ensurePricingLoaded(), ensureFxLoaded()]))
    // Backfill last and pricing first: an imported record is priced at its own
    // timestamp, which needs the catalogue loaded to resolve anything but the
    // built-in overrides.
    .then(() => backfillFromLog())
    .catch(() => {})
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
