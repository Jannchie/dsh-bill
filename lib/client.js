/**
 * Browser half of dsh-bill.
 *
 * Two registrations:
 *   1. `conversation.composer.dock` — a compact per-SESSION cost line right
 *      under the shipped stats line (id `bill`, order 1). It queries
 *      `session-cost` with the current `sessionId` from the slot props, so it
 *      always shows only the active conversation's cost — never the global
 *      total. Visual language mirrors the official StatsLine: block layout,
 *      centered, 12px/20px tertiary text, `·` separators, ellipsis overflow.
 *   2. `settings.section` — a full usage/cost dashboard page (id
 *      `bill`, order 30, label "费用统计"). Cards, panels, tables and
 *      tab rows use the DSH theme tokens (--dsw-alias-* / --dsh-*), so the
 *      page follows the active theme in both light and dark mode.
 *
 * Layout contract: the dashboard is fluid (no fixed max-width) and every
 * row/cell uses `boxSizing: border-box` + `minWidth: 0` so it never overflows
 * the settings panel; the heatmap is built as explicit per-row flex lines
 * (weekday label + 24 cells) so columns always align.
 *
 * Data comes from the host half via `POST /dsh-bill/api`; every amount is
 * returned in USD plus the full USD-based fx rate table, and this half
 * converts to the user's chosen display currency (any of ~166 currencies,
 * CNY default).
 *
 * @module dsh-bill/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-bill',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var el = React.createElement

    // ── DSH theme tokens (CSS variables — follow light/dark theme) ───────────
    var T = {
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      caption: 'var(--dsw-alias-label-caption)',
      sep: 'var(--dsw-alias-separator-primary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      base: 'var(--dsw-alias-bg-base)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary)',
      business: 'var(--dsw-alias-state-business-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    /** Currency picker order — most relevant first, everything else sorted. */
    var CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'INR', 'SGD', 'TWD', 'AUD', 'CAD']
    var CURRENCY_SYMBOL = {
      CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$',
      KRW: '₩', INR: '₹', SGD: 'S$', TWD: 'NT$', AUD: 'A$', CAD: 'C$',
    }

    // ── formatters ──────────────────────────────────────────────────────────
    function fmtTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (Math.round(n / 100) / 10) + 'K'
      return (Math.round(n / 1e5) / 10) + 'M'
    }
    /** Convert USD → display currency with the served fx table. */
    function convert(usd, currency, fx) {
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return null
      if (currency === 'USD') return usd
      var rate = fx && fx[currency]
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
      return usd * rate
    }
    function symbol(code) {
      return CURRENCY_SYMBOL[code] || code + ' '
    }
    function fmtCost(usd, currency, fx) {
      var v = convert(usd, currency, fx)
      if (v === null) return '—'
      // JPY/KRW have no decimals; others 2; tiny amounts 4.
      var digits = (currency === 'JPY' || currency === 'KRW') ? 0 : v >= 100 ? 0 : v >= 1 ? 2 : 4
      // A real but tiny amount must not print as 0 — that reads as "free"
      // rather than "too small to show at this precision".
      var floor = Math.pow(10, -digits)
      if (v > 0 && v < floor) return '<' + symbol(currency) + floor.toFixed(digits)
      return symbol(currency) + v.toFixed(digits)
    }
    function fmtPrice(perM, currency, fx) {
      var v = convert(perM, currency, fx)
      if (v === null) return '—'
      var digits = v >= 1 ? 2 : 4
      return symbol(currency) + v.toFixed(digits)
    }
    function fmtInt(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
      if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M'
      if (n >= 1e4) return (Math.round(n / 100) / 10) + 'K'
      return String(Math.round(n))
    }
    function modelLabel(row) {
      return row.displayName || row.model || 'unknown'
    }
    /**
     * Peak share of a peak/off-peak-priced spend, or null when none of the
     * spend was on such a model.
     *
     * The denominator is peak + off-peak, NOT the total bill: mixing in a
     * flat-priced model would shrink the share for a reason that has nothing
     * to do with when the calls were made. Only DeepSeek's first-party API
     * bills this way today; the host decides that per record, so this stays
     * a pure ratio.
     */
    function peakShare(d) {
      if (!d) return null
      var peakUsd = d.peakUsd || 0
      var offPeakUsd = d.offPeakUsd || 0
      var split = peakUsd + offPeakUsd
      if (split <= 0) return null
      return {
        pct: Math.round(peakUsd / split * 100),
        peakUsd: peakUsd,
        offPeakUsd: offPeakUsd,
        peakCalls: d.peakCalls || 0,
        offPeakCalls: d.offPeakCalls || 0,
      }
    }

    /** Label of our settings page — the registration and the DOM lookup below share it. */
    var SECTION_LABEL = '费用统计'

    /**
     * Open the settings dialog on our section.
     *
     * There is no API for this. The dialog's open state and active section are
     * component-local React state inside the shipped `sidebar.settings`
     * occupant; the one typed `openSection(id)` handle is projected only into
     * `settings.onboarding`, which mounts exclusively on a blank session. So
     * this drives the UI the way a user would.
     *
     * The anchors are the stable ones: `data-slot` wrappers emitted by the slot
     * renderer, and the ARIA attributes the shipped components set. Class names
     * are content-hashed per build and deliberately not used. The section id is
     * not in the DOM, so the nav row is matched by the same label string we
     * registered with.
     *
     * Every failure is a no-op: a dock entry that throws is surfaced as a slot
     * error, and a "view the report" link is not worth that.
     */
    function openSettingsSection(label) {
      try {
        var seat = document.querySelector('[data-slot="sidebar.settings"]')
        if (!seat) return
        var dialogOf = function () { return seat.querySelector('[role="dialog"][aria-modal="true"]') }
        if (!dialogOf()) {
          var trigger = seat.querySelector('button[aria-haspopup="dialog"]')
          if (!trigger) return
          trigger.click()
        }
        // React commits asynchronously, so the dialog and its nav rows may not
        // exist yet; poll a bounded number of frames rather than guessing a delay.
        var tries = 0
        var tick = function () {
          var dialog = dialogOf()
          var rows = dialog ? [].slice.call(dialog.querySelectorAll('nav button')) : []
          for (var i = 0; i < rows.length; i++) {
            if ((rows[i].textContent || '').trim() === label) {
              if (rows[i].getAttribute('aria-current') !== 'true') rows[i].click()
              return
            }
          }
          if (++tries < 30) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      } catch (e) { /* never break the composer over a convenience link */ }
    }

    // ── data hook: POST to host API, re-fetch on dep change + every 8s ───────
    function useCostApi(action, deps) {
      var state = React.useState({ loading: true, data: null, error: null })
      var data = state[0]
      var setData = state[1]
      React.useEffect(function () {
        var alive = true
        function load() {
          fetch('/dsh-bill/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action()),
          }).then(function (r) { return r.json() }).then(function (json) {
            if (alive) setData({ loading: false, data: json, error: null })
          }).catch(function (e) {
            if (alive) setData({ loading: false, data: null, error: e && e.message ? e.message : String(e) })
          })
        }
        load()
        var timer = setInterval(load, 8000)
        return function () { alive = false; clearInterval(timer) }
      }, deps)
      return data
    }

    // ── 1. composer.dock cost readout (one plain line, no hack) ─────────────
    //
    // The shipped stats line (turns/steps) is a full-width centered row above
    // this slot's other entries. We render ONE ordinary line below it, in
    // normal document flow — no negative margin, no absolute positioning:
    //
    //   总消耗 ¥3.64 · 本会话 ¥1.94 · 高峰 62%
    //
    // The two figures come from one `overview` call: `totalUsd` (all-time) and
    // `sessionUsd` (scoped to the current session id). The peak share is the
    // session's DeepSeek spend billed at the peak rate; it is omitted entirely
    // for models that bill one rate around the clock (everything else), since
    // "高峰 0%" would read as a fact rather than as "not applicable".
    var costBlock = {
      display: 'block',
      textAlign: 'center',
      maxWidth: 'var(--dsh-chat-content-width)',
      width: '100%',
      margin: '0 auto',
      boxSizing: 'border-box',
      padding: '0 calc(var(--dsh-composer-side-clearance) + 16px)',
      fontSize: 12,
      lineHeight: '18px',
      color: T.label3,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }
    var costRow = { display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }
    var costLabel = { color: T.label3 }
    var costValue = { color: T.label, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }
    var costSep = { color: T.label3, opacity: 0.5 }
    /** Text-button styled as a link so it sits inside the stats line, not on it. */
    var costLink = {
      border: 0, background: 'transparent', padding: 0, margin: 0,
      font: 'inherit', fontSize: 12, lineHeight: '18px', color: T.label3,
      cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
      textDecorationColor: 'currentColor', opacity: 0.75,
    }

    function CostLine(props) {
      var sessionId = props.sessionId || (props.session && props.session.sessionId)
      var currency = 'CNY'
      var state = useCostApi(function () {
        return { action: 'overview', sessionId: sessionId }
      }, [sessionId])
      if (!sessionId || state.loading || !state.data) return null
      var d = state.data
      if (d.error || d.totalUsd === undefined || d.totalUsd === null) return null
      if (d.totalUsd <= 0) return null
      var fx = d.fx && typeof d.fx === 'object' ? d.fx : { CNY: 6.7878, USD: 1 }

      var items = [
        el('span', { key: 'tl', style: costLabel }, '总消耗'),
        el('span', { key: 'tv', style: costValue }, fmtCost(d.totalUsd, currency, fx)),
        el('span', { key: 'sep1', style: costSep }, '·'),
        el('span', { key: 'sl', style: costLabel }, '本会话'),
        el('span', { key: 'sv', style: costValue }, fmtCost(d.sessionUsd, currency, fx)),
      ]
      var peak = peakShare(d)
      var title = '总消耗 / 本会话费用'
      if (peak) {
        items.push(el('span', { key: 'sep2', style: costSep }, '·'))
        items.push(el('span', { key: 'pl', style: costLabel }, '高峰'))
        items.push(el('span', { key: 'pv', style: costValue }, peak.pct + '%'))
        title += ' · 高峰 ' + fmtCost(peak.peakUsd, currency, fx)
          + ' / 低谷 ' + fmtCost(peak.offPeakUsd, currency, fx) + '(峰谷计价模型)'
      }

      items.push(el('span', { key: 'sep3', style: costSep }, '·'))
      items.push(el('button', {
        key: 'report',
        type: 'button',
        style: costLink,
        title: '打开费用统计',
        onClick: function () { openSettingsSection(SECTION_LABEL) },
      }, '报告'))

      return el('div', { style: costBlock, title: title },
        el('div', { style: costRow }, items))
    }

    // ── 2. settings.section dashboard ────────────────────────────────────────
    // ── 2. settings.section dashboard ────────────────────────────────────────
    //
    // Layout note: this page renders inside the settings dialog, whose content
    // column is ~500px wide. Everything below is designed for that width — a
    // wide-screen layout (multi-column grids, side-by-side charts, a Marimekko
    // with eight labelled columns) collapses into unreadable slivers there.
    //
    // Visual language follows the shipped settings pages: flat sections
    // separated by hairlines rather than nested bordered panels, a 13px/600
    // section title with an 11px tertiary description under it, and controls
    // that reuse the DSH theme tokens so both themes follow automatically.
    var segStyle = { display: 'inline-flex', border: '1px solid ' + T.border, borderRadius: 8, overflow: 'hidden', background: 'transparent' }
    var segBtn = { border: 0, background: 'transparent', padding: '4px 12px', fontSize: 12, cursor: 'pointer', color: T.label2, lineHeight: '18px' }
    var segBtnOn = { ...segBtn, background: T.hover, color: T.label, fontWeight: 600 }

    var card = { border: '1px solid ' + T.border, borderRadius: 10, padding: '10px 12px', background: T.layer1, boxSizing: 'border-box', minWidth: 0 }
    var cardL = { fontSize: 11, color: T.label2, marginBottom: 3 }
    var cardV = { fontSize: 19, fontWeight: 600, color: T.label, fontVariantNumeric: 'tabular-nums', lineHeight: '24px' }
    var cardH = { fontSize: 10, color: T.label3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    /** A flat section: hairline above, generous top margin, no box. */
    var section = { marginTop: 20, paddingTop: 16, borderTop: '1px solid ' + T.border, boxSizing: 'border-box', minWidth: 0 }
    var panelT = { fontSize: 13, fontWeight: 600, color: T.label, marginBottom: 2 }
    var panelSub = { fontSize: 11, color: T.label3, lineHeight: '16px', marginBottom: 12 }
    var th = { textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid ' + T.border2, whiteSpace: 'nowrap', color: T.label2, fontWeight: 500, fontSize: 11 }
    var thFirst = { ...th, textAlign: 'left' }
    var td = { textAlign: 'right', padding: '6px 6px', borderBottom: '1px solid ' + T.border, whiteSpace: 'nowrap', color: T.label, fontSize: 12, fontVariantNumeric: 'tabular-nums' }
    var tdFirst = { ...td, textAlign: 'left', fontVariantNumeric: 'normal' }

    // ── cost attribution ────────────────────────────────────────────────────
    //
    // One full-width stacked bar for the whole bill, then one row per category
    // with its children indented under it.
    //
    // The reference design uses a Marimekko (column width = share of bill,
    // block height = share within column). That needs horizontal room per
    // column for a label; with eight categories in a 500px pane every column
    // is ~60px and the labels turn into vertical noise. A stacked bar keeps
    // the same "one axis = share of the bill" property, and the per-category
    // rows carry the within-category split that the column heights carried.
    var CAT_COLOR = {
      'tool-read': '#d99a2b',
      'model': '#4a90e2',
      'system': '#9b7ede',
      'terminal': '#e2803a',
      'tool-write': '#65b84a',
      'media': '#e2607a',
      'scaffold': '#c96ad4',
      'user': '#8a8f98',
    }
    function catColor(cat) { return CAT_COLOR[cat] || '#8a8f98' }

    // Display text lives here, not in the host: the host stores category and
    // detail IDs (they are a storage format), the browser owns presentation.
    var CAT_LABEL = {
      'tool-read': '工具输出',
      'model': '模型输出',
      'system': '系统提示词',
      'terminal': '终端命令',
      'tool-write': '工具输入',
      'media': '附件',
      'scaffold': '系统提醒',
      'user': '用户输入',
    }
    var DETAIL_LABEL = {
      'prompt.system': '系统提示词',
      'prompt.tools': '工具 schema',
      'model.reply.carried': '历史回复',
      'model.thinking.carried': '历史思考',
      'model.tool-args': '调用参数',
      'model.reply': '本次回复',
      'model.thinking': '本次思考',
      'user.typed': '用户输入',
      'scaffold.reminder': '系统提醒',
      'media.attachment': '附件',
      'tool.unknown': '未知工具',
    }
    function catLabel(cat) { return CAT_LABEL[cat] || cat }
    /** Fixed details resolve to copy; tool names and shell programs pass through. */
    function detailLabel(sub) { return DETAIL_LABEL[sub] || sub }

    // ── sunburst ────────────────────────────────────────────────────────────
    var TAU = Math.PI * 2
    function polar(cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
    /**
     * An annulus sector.
     *
     * The sweep is clamped just under a full turn: at exactly 360° the arc's
     * start and end points coincide and SVG draws nothing, which is precisely
     * the case a drilled-in single category hits.
     */
    function arcPath(cx, cy, rIn, rOut, a0, a1) {
      var sweep = Math.min(a1 - a0, TAU - 0.0001)
      var end = a0 + sweep
      var large = sweep > Math.PI ? 1 : 0
      var r = function (n) { return Math.round(n * 100) / 100 }
      var p0 = polar(cx, cy, rOut, a0)
      var p1 = polar(cx, cy, rOut, end)
      var p2 = polar(cx, cy, rIn, end)
      var p3 = polar(cx, cy, rIn, a0)
      return 'M' + r(p0[0]) + ' ' + r(p0[1])
        + 'A' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + r(p1[0]) + ' ' + r(p1[1])
        + 'L' + r(p2[0]) + ' ' + r(p2[1])
        + 'A' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + r(p3[0]) + ' ' + r(p3[1]) + 'Z'
    }

    /**
     * Two-ring sunburst with drill-down: categories on the inner ring, their
     * details on the outer one.
     *
     * Clicking a category makes it the whole circle so its details get the full
     * 360° to spread out — the reason to drill in at all is that a 2% category's
     * children are unreadable slivers at root level. The centre doubles as the
     * way back and as the readout: hovering any arc names it there rather than
     * printing labels the arcs are too narrow to hold.
     */
    function Sunburst(props) {
      var hoverState = React.useState(null)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      var focus = props.focus
      var size = 244
      var cx = size / 2
      var cy = size / 2
      var r0 = 52
      var r1 = 84
      var r2 = 112

      var rows = props.categories
      var focused = focus ? rows.filter(function (r) { return r.cat === focus })[0] : null
      var ring1 = focused ? [focused] : rows
      var ring1Total = ring1.reduce(function (s, r) { return s + r.usd }, 0)
      if (!(ring1Total > 0)) return null

      var arcs = []
      var angle = -Math.PI / 2
      ring1.forEach(function (row) {
        var sweep = row.usd / ring1Total * TAU
        var color = catColor(row.cat)
        arcs.push({
          key: 'c:' + row.cat, d: arcPath(cx, cy, r0, r1, angle, angle + sweep),
          fill: color, opacity: 1, cat: row.cat, usd: row.usd,
          name: catLabel(row.cat), onClick: function () { props.onFocus(focus === row.cat ? null : row.cat) },
        })
        var childTotal = (row.children || []).reduce(function (s, c) { return s + c.usd }, 0)
        var childAngle = angle
        ;(row.children || []).forEach(function (child, i) {
          var childSweep = childTotal > 0 ? child.usd / childTotal * sweep : 0
          arcs.push({
            key: 'd:' + row.cat + ':' + child.sub,
            d: arcPath(cx, cy, r1 + 2, r2, childAngle, childAngle + childSweep),
            fill: color, opacity: 0.82 - (i % 4) * 0.16, cat: row.cat, usd: child.usd,
            name: detailLabel(child.sub),
            onClick: function () { props.onFocus(focus === row.cat ? null : row.cat) },
          })
          childAngle += childSweep
        })
        angle += sweep
      })

      // Centre readout: whatever is hovered, else the drilled-in category, else
      // the whole attributed bill.
      var centreName = hover ? hover.name : focused ? catLabel(focused.cat) : '已归因'
      var centreUsd = hover ? hover.usd : focused ? focused.usd : props.total
      var centrePct = props.total > 0 ? Math.round(centreUsd / props.total * 1000) / 10 : 0

      return el('div', { style: { display: 'flex', justifyContent: 'center', paddingTop: 4 } },
        el('svg', {
          width: size, height: size, viewBox: '0 0 ' + size + ' ' + size,
          style: { display: 'block', overflow: 'visible' },
          onMouseLeave: function () { setHover(null) },
        },
          arcs.map(function (arc) {
            return el('path', {
              key: arc.key, d: arc.d, fill: arc.fill, fillOpacity: arc.opacity,
              stroke: T.base, strokeWidth: 1,
              style: { cursor: 'pointer', transition: 'fill-opacity .12s' },
              onMouseEnter: function () { setHover(arc) },
              onClick: arc.onClick,
            }, el('title', null, arc.name + ' · ' + props.fmt(arc.usd)))
          }),
          el('circle', {
            cx: cx, cy: cy, r: r0 - 2, fill: 'transparent',
            style: { cursor: focused ? 'pointer' : 'default' },
            onMouseEnter: function () { setHover(null) },
            onClick: function () { if (focused) props.onFocus(null) },
          }),
          el('text', {
            x: cx, y: cy - 8, textAnchor: 'middle', fill: 'var(--dsw-alias-label-tertiary)',
            style: { fontSize: 11, pointerEvents: 'none' },
          }, centreName),
          el('text', {
            x: cx, y: cy + 11, textAnchor: 'middle', fill: 'var(--dsw-alias-label-primary)',
            style: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' },
          }, props.fmt(centreUsd)),
          el('text', {
            x: cx, y: cy + 26, textAnchor: 'middle', fill: 'var(--dsw-alias-label-tertiary)',
            style: { fontSize: 10, pointerEvents: 'none' },
          }, focused ? '← 返回' : centrePct + '%')))
    }

    /** One category row: header, share, and its details indented under it. */
    function AttributionRow(props) {
      var row = props.row
      var color = catColor(row.cat)
      var pct = props.total > 0 ? row.usd / props.total * 100 : 0
      var maxChild = (row.children || []).reduce(function (m, c) { return Math.max(m, c.usd) }, 0)
      var children = (row.children || []).length > 1 ? row.children : []
      var active = props.focus === row.cat
      return el('div', {
        style: {
          marginTop: 10, minWidth: 0, cursor: 'pointer', borderRadius: 6,
          padding: '2px 6px', margin: '8px -6px 0',
          background: active ? T.hover : 'transparent',
        },
        onClick: function () { props.onFocus(active ? null : row.cat) },
      },
        el('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          el('span', {
            style: {
              width: 8, height: 8, borderRadius: 2, background: color,
              flexShrink: 0, alignSelf: 'center',
            },
          }),
          el('span', {
            style: {
              fontSize: 12, color: T.label, fontWeight: 500, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, catLabel(row.cat)),
          el('span', { style: { fontSize: 11, color: T.label3, flexShrink: 0, fontVariantNumeric: 'tabular-nums' } },
            (Math.round(pct * 10) / 10) + '%'),
          el('span', {
            style: {
              marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: T.label,
              fontVariantNumeric: 'tabular-nums', flexShrink: 0,
            },
          }, props.fmt(row.usd))),
        children.length
          ? el('div', { style: { marginLeft: 16, marginTop: 4 } }, children.map(function (child) {
              return el('div', {
                key: child.sub,
                style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 3 },
              },
                el('span', {
                  style: {
                    fontSize: 11, color: T.label2, flex: '0 0 38%', minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontStyle: child.folded ? 'italic' : 'normal',
                  },
                  title: detailLabel(child.sub),
                }, detailLabel(child.sub)),
                el('div', {
                  style: {
                    flex: '1 1 auto', height: 3, borderRadius: 2, background: T.hover,
                    overflow: 'hidden', minWidth: 0,
                  },
                },
                  el('div', {
                    style: {
                      width: (maxChild > 0 ? child.usd / maxChild * 100 : 0) + '%',
                      height: '100%', background: color, opacity: 0.7,
                    },
                  })),
                el('span', {
                  style: {
                    fontSize: 11, color: T.label2, fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0, minWidth: 52, textAlign: 'right',
                  },
                }, props.fmt(child.usd)))
            }))
          : null)
    }


    function CurrencySelect(props) {
      var options = []
      var seen = {}
      CURRENCIES.forEach(function (code) {
        if (props.fx && props.fx[code] !== undefined) {
          seen[code] = true
          options.push(code)
        }
      })
      Object.keys(props.fx || {}).sort().forEach(function (code) {
        if (!seen[code]) options.push(code)
      })
      return el('select', {
        value: props.value,
        onChange: function (e) { props.onChange(e.target.value) },
        style: {
          border: '1px solid ' + T.border, background: 'transparent', color: T.label,
          borderRadius: 8, padding: '3px 8px', fontSize: 12, cursor: 'pointer', outline: 'none',
          maxWidth: 130, minWidth: 0,
        },
      }, options.map(function (code) {
        return el('option', { key: code, value: code },
          (CURRENCY_SYMBOL[code] ? CURRENCY_SYMBOL[code] + ' ' : '') + code)
      }))
    }

    /** One heatmap row: weekday label (fixed 28px) + 24 equal-width cells. */
    function heatmapRow(weekday, cells, cellStyle, titleOf) {
      var label = el('div', {
        style: { width: 28, flexShrink: 0, fontSize: 10, color: T.label3, lineHeight: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      }, weekday === null ? '' : weekday)
      var items = [label]
      for (var h = 0; h < 24; h++) {
        var cell = cells[h]
        items.push(el('div', {
          key: 'h' + h,
          style: { flex: '1 1 0', minWidth: 0, height: 16, marginLeft: h === 0 ? 0 : 2, borderRadius: 3, boxSizing: 'border-box', ...cellStyle(cell) },
          title: titleOf(cell),
        }))
      }
      return el('div', {
        key: 'w' + weekday,
        style: { display: 'flex', alignItems: 'center', marginTop: 2, minWidth: 0 },
      }, items)
    }

    function Dashboard() {
      var range = React.useState(30)
      var rangeDays = range[0]
      var setRange = range[1]
      var cur = React.useState('CNY')
      var currency = cur[0]
      var setCurrency = cur[1]
      // Which category the sunburst is drilled into (null = the whole bill).
      var focusState = React.useState(null)
      var attrFocus = focusState[0]
      var setAttrFocus = focusState[1]

      var state = useCostApi(function () {
        return { action: 'dashboard', rangeDays: rangeDays }
      }, [rangeDays])
      var d = state.data
      var fx = d && d.fx && typeof d.fx === 'object' ? d.fx : { CNY: 6.7878, USD: 1 }
      var attr = d && d.attribution ? d.attribution : null
      // How much of the range's bill the attribution tree actually covers —
      // shown whenever it is not effectively all of it, so a partial tree is
      // never read as the whole story.
      var attrCoverage = attr && attr.rangeUsd > 0
        ? Math.round(attr.attributedUsd / attr.rangeUsd * 100)
        : null

      // KPI cards
      var kpis = []
      if (d && !d.error) {
        var perDay = (d.totalUsd || 0) / Math.max(1, rangeDays)
        var cacheHit = d.cacheReadTokens + d.uncachedInputTokens + d.cacheWriteTokens > 0
          ? Math.round(d.cacheReadTokens / (d.cacheReadTokens + d.uncachedInputTokens + d.cacheWriteTokens) * 100)
          : null
        kpis = [
          { label: '总费用', value: fmtCost(d.totalUsd, currency, fx), hint: rangeDays + ' 天 · 日均 ' + fmtCost(perDay, currency, fx) },
          { label: 'Token 用量', value: fmtTokens(d.tokens), hint: '输入 ' + fmtTokens(d.uncachedInputTokens) + ' · 输出 ' + fmtTokens(d.outputTokens) },
          { label: '模型调用', value: fmtInt(d.calls), hint: (d.byModel ? d.byModel.length : 0) + ' 个模型' },
          { label: '缓存命中', value: cacheHit === null ? '—' : cacheHit + '%', hint: '读 ' + fmtTokens(d.cacheReadTokens) + ' · 写 ' + fmtTokens(d.cacheWriteTokens) },
        ]
        // Only for models that actually bill peak/off-peak (DeepSeek
        // first-party). Everything else has no peak rate to be a share of.
        var peak = peakShare(d)
        if (peak) {
          kpis.push({
            label: '高峰占比',
            value: peak.pct + '%',
            hint: '高峰 ' + fmtCost(peak.peakUsd, currency, fx) + ' · 低谷 ' + fmtCost(peak.offPeakUsd, currency, fx),
          })
        }
      }

      // Heatmap: build a [7][24] matrix from the flat list.
      var heatGrid = []
      for (var w = 0; w < 7; w++) {
        var row = new Array(24)
        for (var h = 0; h < 24; h++) row[h] = { weekday: w, hour: h, usd: 0, calls: 0 }
        heatGrid.push(row)
      }
      var maxCell = 0
      if (d && d.heatmap) {
        for (var i = 0; i < d.heatmap.length; i++) {
          var cell = d.heatmap[i]
          if (cell.weekday >= 0 && cell.weekday < 7 && cell.hour >= 0 && cell.hour < 24) {
            heatGrid[cell.weekday][cell.hour] = cell
            if (cell.usd > maxCell) maxCell = cell.usd
          }
        }
      }
      function cellStyle(cell) {
        if (cell.usd <= 0 || maxCell <= 0) return { background: 'rgba(128,128,128,.12)' }
        var t = cell.usd / maxCell
        var alpha = 0.15 + 0.8 * t
        return { background: 'rgba(90,140,255,' + alpha.toFixed(2) + ')' }
      }
      function cellTitle(cell) {
        return cell.hour + ':00 · ' + fmtCost(cell.usd, currency, fx) + ' · ' + cell.calls + ' 次'
      }
      var weekLabels = ['日', '一', '二', '三', '四', '五', '六']
      var hourTicks = [0, 6, 12, 18, 23]

      var maxDay = 0
      if (d && d.timelineDays) {
        for (var j = 0; j < d.timelineDays.length; j++) if (d.timelineDays[j].usd > maxDay) maxDay = d.timelineDays[j].usd
      }

      var fxSourceText = d && d.fxSource === 'live' ? '实时' : '固定'

      return el('div', { style: { padding: '16px 16px', width: '100%', boxSizing: 'border-box', minWidth: 0 } },

        // header
        el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 14, minWidth: 0 } },
          el('div', { style: { minWidth: 0 } },
            el('div', { style: { fontSize: 15, fontWeight: 600, color: T.label } }, '费用统计'),
            el('div', { style: { fontSize: 11, color: T.label3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              '价格 llm-pricing · 汇率 ' + fxSourceText)),
          el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            el('span', { style: segStyle },
              [7, 30, 90, 365].map(function (days) {
                return el('button', {
                  key: days,
                  style: rangeDays === days ? segBtnOn : segBtn,
                  onClick: function () { setRange(days) },
                }, days + '天')
              })),
            el(CurrencySelect, { value: currency, fx: fx, onChange: setCurrency }))),

        state.loading ? el('div', { style: { fontSize: 12, color: T.label3, padding: '20px 0' } }, '加载中…')
          : state.error ? el('div', { style: { fontSize: 12, color: T.error, padding: '8px 0' } }, '加载失败: ' + state.error)
            : d && d.error ? el('div', { style: { fontSize: 12, color: T.error, padding: '8px 0' } }, '接口错误: ' + d.error)
              : !d || d.calls === 0 ? el('div', { style: { fontSize: 12, color: T.label3, padding: '20px 0' } }, '该时间范围内暂无调用记录。')
                : el('div', null,

                  // KPI — two per row at the settings pane's width, so the
                  // last card never orphans on a row of its own.
                  el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 } },
                    kpis.map(function (kpi, i) {
                      // An odd card count would leave the last one alone on a
                      // half-empty row; let it take the whole width instead.
                      var last = i === kpis.length - 1 && kpis.length % 2 === 1
                      return el('div', { key: kpi.label, style: last ? { ...card, gridColumn: 'span 2' } : card },
                        el('div', { style: cardL }, kpi.label),
                        el('div', { style: cardV }, kpi.value),
                        kpi.hint ? el('div', { style: cardH, title: kpi.hint }, kpi.hint) : null)
                    })),

                  // cost attribution — where the money went, by content kind
                  attr && attr.categories && attr.categories.length
                    ? el('div', { style: section },
                        el('div', { style: panelT }, '成本归因'),
                        el('div', { style: panelSub },
                          '按内容类型拆分。每次请求为完整上下文计费,历史内容重复计价。'
                          + (attrCoverage !== null && attrCoverage < 99
                            ? '已覆盖 ' + fmtCost(attr.attributedUsd, currency, fx) + ' / '
                              + fmtCost(attr.rangeUsd, currency, fx)
                              + '(' + (attrCoverage < 1 ? '<1' : attrCoverage) + '%),早期记录无归因数据。'
                            : '')),
                        el(Sunburst, {
                          categories: attr.categories, total: attr.attributedUsd,
                          focus: attrFocus, onFocus: setAttrFocus,
                          fmt: function (v) { return fmtCost(v, currency, fx) },
                        }),
                        el('div', { style: { marginTop: 10 } }, attr.categories.map(function (row) {
                          return el(AttributionRow, {
                            key: row.cat, row: row, total: attr.attributedUsd,
                            focus: attrFocus, onFocus: setAttrFocus,
                            fmt: function (v) { return fmtCost(v, currency, fx) },
                          })
                        })))
                    : null,

                  // per-model breakdown
                  el('div', { style: section },
                    el('div', { style: panelT }, '按模型费用'),
                    el('div', { style: { overflowX: 'auto', minWidth: 0 } },
                      el('table', { style: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 460 } },
                        el('thead', null, el('tr', null,
                          el('th', { style: { ...thFirst, width: '34%' } }, '模型'),
                          el('th', { style: th }, '调用'),
                          el('th', { style: th }, '输入'),
                          el('th', { style: th }, '输出'),
                          el('th', { style: th }, '费用'))),
                        el('tbody', null,
                          (d.byModel || []).map(function (row) {
                            var pct = d.totalUsd > 0 ? Math.round((row.usd || 0) / d.totalUsd * 100) : 0
                            // Base rate in the model's own official currency, as a
                            // compact secondary line under the model name (keeps the
                            // table narrow — never in a wide dedicated column).
                            var nativeCur = row.base ? (row.base.currency || 'USD') : null
                            var baseLine = row.base
                              ? fmtPrice(row.base.inputPerM, nativeCur, fx) + '/' + fmtPrice(row.base.outputPerM, nativeCur, fx) + ' ' + nativeCur + '/M'
                              : null
                            // Peak-priced models get their split appended to the
                            // same secondary line; flat-priced ones show nothing.
                            var rowPeak = peakShare(row)
                            if (rowPeak) {
                              baseLine = (baseLine ? baseLine + ' · ' : '') + '高峰 ' + rowPeak.pct + '%'
                            }
                            return el('tr', { key: row.provider + '/' + row.model },
                              el('td', { style: tdFirst },
                                el('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
                                  el('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modelLabel(row)),
                                  row.priced ? null : el('span', { style: { flexShrink: 0, padding: '0 5px', borderRadius: 999, fontSize: 10, background: 'rgba(255,152,0,.16)', color: T.warn } }, '?'),
                                  el('span', { style: { flexShrink: 0, color: T.label3, fontSize: 11 } }, pct + '%')),
                                baseLine ? el('div', { style: { fontSize: 10, color: T.label3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, baseLine) : null),
                              el('td', { style: td }, String(row.calls)),
                              el('td', { style: td }, fmtTokens(row.inputTokens)),
                              el('td', { style: td }, fmtTokens(row.outputTokens)),
                              el('td', { style: { ...td, fontWeight: 600 } }, fmtCost(row.usd, currency, fx)))
                          }))))),

                  // daily timeline
                  el('div', { style: section },
                    el('div', { style: panelT }, '每日费用'),
                    d.timelineDays && d.timelineDays.length
                      ? el('div', null,
                          el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 76, paddingTop: 4, minWidth: 0, borderBottom: '1px solid ' + T.border } },
                            d.timelineDays.map(function (day) {
                              return el('div', {
                                key: day.day,
                                style: {
                                  flex: '1 1 0', minWidth: 2, maxWidth: 28, borderRadius: '2px 2px 0 0', background: T.business,
                                  height: maxDay > 0 ? Math.max(2, Math.round(day.usd / maxDay * 72)) + 'px' : '2px',
                                  opacity: 0.85,
                                },
                                title: day.day + ' · ' + fmtCost(day.usd, currency, fx) + ' · ' + day.calls + ' 次调用',
                              })
                            })),
                          el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.label3, marginTop: 4 } },
                            el('span', null, d.timelineDays[0] ? d.timelineDays[0].day : ''),
                            el('span', null, d.timelineDays[d.timelineDays.length - 1] ? d.timelineDays[d.timelineDays.length - 1].day : '')))
                      : el('div', { style: { fontSize: 12, color: T.label3, padding: '8px 0' } }, '该范围内没有按日数据')),

                  // heatmap
                  el('div', { style: section },
                    el('div', { style: panelT }, '周 × 小时热力图(UTC)'),
                    el('div', { style: { overflowX: 'auto', minWidth: 0 } },
                      el('div', { style: { minWidth: 480 } },
                        // hour tick row
                        el('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } },
                          el('div', { style: { width: 28, flexShrink: 0 } }),
                          hourTicks.map(function (h) {
                            return el('div', {
                              key: 'tick' + h,
                              style: { flex: '1 1 0', minWidth: 0, fontSize: 9, color: T.label3, lineHeight: '12px', textAlign: 'left', paddingLeft: h === 0 ? 0 : 2 },
                            }, String(h))
                          })),
                        // one row per weekday
                        weekLabels.map(function (label, w) {
                          return heatmapRow(label, heatGrid[w], cellStyle, cellTitle)
                        })))),
                  // footnote
                  el('div', { style: { fontSize: 10, color: T.label3, marginTop: 8, lineHeight: 1.6, overflowWrap: 'break-word' } },
                    '费用为估算值。未收录的模型标记为「?」,不参与合计;基础单价按模型官方定价货币显示。')))
    }

    // ── plugin definition ───────────────────────────────────────────────────
    exports.name = 'dsh-bill'
    exports.inject = ['slots']

    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      // Cost line under the shipped stats line (current session only).
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          { name: 'conversation.composer.dock', id: 'bill', order: 1 },
          CostLine,
        )
      })

      // Full dashboard page in settings.
      slots.inject('settings.section', function () {
        return slots.register(
          // Same constant the dock link matches on — the section id is not in
          // the DOM, so the label is the only handle, and the two must not drift.
          { name: 'settings.section', id: 'bill', order: 30, label: SECTION_LABEL },
          Dashboard,
        )
      })
    }

    return module.exports
  },
})
