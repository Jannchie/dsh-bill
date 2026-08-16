/**
 * Browser half of dsh-bill.
 *
 * Five seats, chosen so each answer sits where the question is asked:
 *
 *   1. `conversation.composer.dock` — a compact per-SESSION cost line under
 *      the shipped stats line (id `bill`, order 1). Visual language mirrors
 *      the official StatsLine: block layout, centered, 12px/20px tertiary
 *      text, `·` separators, ellipsis overflow.
 *   2. `conversation.chat.turnTail` — what each finished turn cost, under
 *      that turn. A chain entry, routed by a pure selector on the turn being
 *      closed. This is the seat that answers "which turn was expensive?",
 *      which no total can.
 *   3. `conversation.view` — the full report, as a tab beside Chat and
 *      Trajectory (id `bill`, order 30, label "费用"). A readout about the
 *      work in this window belongs at the width that work is displayed at.
 *   4. `settings.section` — configuration only: the budget, and a pointer to
 *      the tab. A report is not a setting.
 *   5. `sidebar.footer.action` — today's spend against the budget, always
 *      visible, so overspending is noticed on the day.
 *
 * Everything visual is expressed in the host's design tokens: colours through
 * `--dsw-alias-*`, type through the composite `--dsw-font-*` ramp, and the
 * interactive states (hover, focus, disabled) through one injected stylesheet
 * keyed on `data-plugin-css`, which is how DSH's own plugins ship CSS. The
 * primitives package those plugins import is bundled at their build time and
 * is not a loadable module here, so the controls are hand-built — but to the
 * shipped geometry (28px pill controls, 34px sidebar rows, 30px table rows).
 *
 * Layout contract: the report is fluid and every row/cell uses
 * `boxSizing: border-box` + `minWidth: 0`, so the same component fits both a
 * full-width view tab and the settings dialog's ~500px column; the heatmap is
 * built as explicit per-row flex lines (weekday label + 24 cells) so columns
 * always align.
 *
 * Two data paths, for two different shapes of question:
 *
 *   - Per-session and per-turn figures arrive through `useProjection`, PUSHED
 *     by the host's `billTurns` unit. No fetch, no timer, and they cover the
 *     whole durable session log rather than only what this plugin captured
 *     live.
 *   - Whole-history aggregation is requested from the host, over the
 *     Connection RPC channel when there is one and a plain POST otherwise.
 *     It refetches when the projection reports a finished turn, with a slow
 *     interval underneath to catch spend from another window.
 *
 * Every amount crosses in USD, alongside the full USD-based fx rate table,
 * and this half converts to the user's chosen display currency (any of ~166
 * currencies, CNY default).
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
      border3: 'var(--dsw-alias-border-l3)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      base: 'var(--dsw-alias-bg-base)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary)',
      business: 'var(--dsw-alias-state-business-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      warnLabel: 'var(--dsw-alias-state-warn-label)',
      error: 'var(--dsw-alias-state-error-primary)',
      ease: 'var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1))',
    }

    // ── DSH type ramp ───────────────────────────────────────────────────────
    //
    // The design system publishes its typography as composite `font` shorthand
    // variables (`--dsw-font-xxs-12` = `12px/18px var(--dsw-font-family)`), and
    // every shipped surface consumes them rather than restating a size. Doing
    // the same is what keeps this plugin on the same ramp when the ramp moves:
    // there is no such thing as "close to 12px" here, only on the ramp or off
    // it, and the sizes this file used to carry (9, 10, 19) were off it.
    //
    // Consumed bare, with no `var()` fallback, exactly as DSH consumes them —
    // the font tokens ship from the same stylesheet as the `--dsw-alias-*`
    // colours above, so a host that has not defined them has not defined
    // anything this file draws with either. Restating each step's numbers as a
    // fallback would defend one property against a failure the other twenty
    // already share, at the cost of putting the ramp's values in two places.
    //
    // Objects rather than bare strings because `font` is a shorthand that
    // resets `font-variant-numeric`: a caller that wants tabular figures must
    // set them AFTER the shorthand, and spreading guarantees that order.
    var F = {
      /** 11px/14px — dense chrome: axis ticks, unit suffixes. The floor. */
      xxxs: { font: 'var(--dsw-font-xxxs-11)' },
      /** 12px/18px — the workhorse: hints, table cells, secondary lines. */
      xxs: { font: 'var(--dsw-font-xxs-12)' },
      xxsStrong: { font: 'var(--dsw-font-xxs-strong-12)' },
      /** 13px/20px — in-chat annotations; what the shipped turn-tail uses. */
      xs: { font: 'var(--dsw-font-xs-13)' },
      xsStrong: { font: 'var(--dsw-font-xs-strong-13)' },
      /** 14px/22px — body copy and controls. */
      s: { font: 'var(--dsw-font-s-14)' },
      sStrong: { font: 'var(--dsw-font-s-strong-14)' },
      /** 16px/24px — page and section titles. */
      baseStrong: { font: 'var(--dsw-font-base-strong-16)' },
      /** 20px/28px, weight 500 — the one display step, for a headline figure. */
      l: { font: 'var(--dsw-font-l-20)' },
    }
    /** Figures: same step, but digits that line up in a column. */
    function numeric(step) { return { ...step, fontVariantNumeric: 'tabular-nums' } }
    /**
     * The tabular variants, built once.
     *
     * Every `numeric()` call in a render path takes a literal step, so the
     * result is a constant — computing it per render allocated a throwaway
     * object per figure, and the report draws a few hundred figures.
     */
    var N = {
      xxxs: numeric(F.xxxs),
      xxs: numeric(F.xxs),
      xxsStrong: numeric(F.xxsStrong),
      xsStrong: numeric(F.xsStrong),
      baseStrong: numeric(F.baseStrong),
      l: numeric(F.l),
    }

    /** One line clamped to its box. Spelled out seven times before this. */
    var ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

    // ── stylesheet ──────────────────────────────────────────────────────────
    //
    // The split against the inline style objects below is: anything named and
    // reused — a control, a repeated row, a verbatim copy of a host rule — is a
    // class here; the inline objects carry only what varies per instance.
    //
    // Hover, focus and disabled states force the issue, since inline styles
    // cannot express a pseudo-class at all. DSH's own plugins solve that by
    // appending one `<style>` tag keyed on `data-plugin-css` and addressing it
    // with prefixed classes, so this does the same rather than inventing a JS
    // hover-state mechanism. Without it every control in this plugin was inert
    // to the pointer while every control beside it lit up — the loudest way a
    // surface reads as foreign, and one no amount of matching colour fixes.
    //
    // The geometry is lifted from the shipped settings pages: 28px pill
    // controls (radius = half the height) for compact actions, 34/36px for the
    // sidebar row, `interactive-bg-hover` on hover, and a 2px `border-l3` ring
    // on `:focus-visible` — never `outline: none` alone, which would take the
    // keyboard affordance away and give nothing back.
    /** The one motion duration, so it stays one value. */
    var EASE = '.12s ' + T.ease
    var CSS = `
      /* Compact actions and text fields share one 28px pill. */
      .dshbill-btn,.dshbill-field{box-sizing:border-box;height:28px;padding:0 10px;
        border-radius:14px;border:1px solid ${T.border2};background:0 0;
        color:${T.label};font:${F.xxs.font}}
      .dshbill-btn{cursor:pointer;display:inline-flex;align-items:center;
        justify-content:center;gap:4px;
        transition:background-color ${EASE},color ${EASE}}
      .dshbill-btn:hover:not(:disabled){background:${T.hover}}
      .dshbill-btn:disabled{opacity:.4;cursor:default}
      /* Quiet variant: no outline until you reach for it. */
      .dshbill-btn-quiet{border-color:transparent;color:${T.label3}}
      .dshbill-btn-quiet:hover:not(:disabled){color:${T.label}}
      .dshbill-field{font-variant-numeric:tabular-nums;outline:none;
        transition:border-color ${EASE}}
      .dshbill-field:hover{border-color:${T.border3}}

      /* Segmented range/period picker: one outline around the group. */
      .dshbill-seg{display:inline-flex;border:1px solid ${T.border2};
        border-radius:14px;overflow:hidden;background:0 0}
      .dshbill-seg>button{box-sizing:border-box;height:28px;padding:0 12px;border:0;
        background:0 0;color:${T.label2};font:${F.xxs.font};cursor:pointer;
        transition:background-color ${EASE},color ${EASE}}
      .dshbill-seg>button:hover{background:${T.hover};color:${T.label}}
      .dshbill-seg>button[data-on=true]{background:${T.hover};color:${T.label};
        font:${F.xxsStrong.font}}

      /* The per-session cost line, under the shipped StatsLine. Copied from
         that rule verbatim, 12px/20px included — one step off the ramp, in
         DSH's source too, to clear the composer. The two lines stack, so any
         difference between them reads as a misalignment, not a distinction. */
      .dshbill-dock{display:block;box-sizing:border-box;width:100%;margin:0 auto;
        max-width:var(--dsh-chat-content-width);
        padding:0 calc(var(--dsh-composer-side-clearance) + 16px);
        font:12px/20px var(--dsw-font-family);color:${T.label3};
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* Inline text action, sitting inside that line rather than on it. */
      .dshbill-link{border:0;background:0 0;padding:0;margin:0;font:inherit;
        color:inherit;cursor:pointer;text-decoration:underline;
        text-underline-offset:2px;text-decoration-color:currentColor;opacity:.75;
        transition:opacity ${EASE}}
      .dshbill-link:hover{opacity:1}

      /* Sidebar footer entry: the settings trigger's geometry, exactly, so the
         two stack as one control group rather than a button and a caption. */
      .dshbill-spend{box-sizing:border-box;width:calc(100% + 8px);height:34px;
        margin:4px -4px;padding:6px 10px;border:0;border-radius:12px;background:0 0;
        cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0;
        transition:background-color ${EASE}}
      .dshbill-spend:hover{background:${T.hover}}
      .dshbill-spend[data-rail=true]{width:36px;height:36px;margin:4px 0;padding:0;
        border-radius:50%;justify-content:center}

      /* Report table: the Trajectory table's row metrics and hover. */
      .dshbill-table{width:100%;border-collapse:collapse;table-layout:fixed}
      .dshbill-table th,.dshbill-table td{box-sizing:border-box;height:30px;
        padding:0 8px;text-align:right;white-space:nowrap}
      .dshbill-table th{color:${T.label3};font:${F.xxsStrong.font};
        border-bottom:1px solid ${T.border2}}
      .dshbill-table td{color:${T.label};font:${F.xxs.font};
        font-variant-numeric:tabular-nums;border-bottom:1px solid ${T.border}}
      .dshbill-table th:first-child,.dshbill-table td:first-child{text-align:left}
      .dshbill-table td:first-child{font-variant-numeric:normal}
      .dshbill-table tbody tr{transition:background-color ${EASE}}
      .dshbill-table tbody tr:hover{background:${T.hover}}

      /* Attribution rows and sunburst arcs are one control: both select a
         category, so both answer the pointer. */
      .dshbill-attr{border-radius:6px;padding:2px 6px;margin:8px -6px 0;min-width:0;
        cursor:pointer;transition:background-color ${EASE}}
      .dshbill-attr:hover,.dshbill-attr[data-on=true]{background:${T.hover}}
      .dshbill-arc{cursor:pointer;transition:fill-opacity ${EASE}}
      .dshbill-arc:hover{fill-opacity:1}

      /* One focus ring for every control here, matching the settings pages. */
      .dshbill-btn:focus-visible,.dshbill-seg>button:focus-visible,
      .dshbill-field:focus-visible,.dshbill-link:focus-visible,
      .dshbill-spend:focus-visible{box-shadow:0 0 0 2px ${T.border3};outline:none}

      @media (prefers-reduced-motion:reduce){.dshbill-btn,.dshbill-seg>button,
        .dshbill-field,.dshbill-link,.dshbill-spend,.dshbill-table tbody tr,
        .dshbill-attr,.dshbill-arc{transition:none}}
    `

    // Append the sheet once, keyed the way the host keys its own. Guarded on
    // `document` (the module is evaluated in tests without a DOM) and on the
    // key, so a hot reload that re-evaluates this factory replaces the sheet
    // rather than stacking a second copy.
    var CSS_KEY = 'dsh-bill/bill.css'
    if (typeof document !== 'undefined' && document.head
      && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']')) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-bill'
      styleTag.dataset.pluginCss = CSS_KEY
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    /** Currency picker order — most relevant first, everything else sorted. */
    var CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'INR', 'SGD', 'TWD', 'AUD', 'CAD']
    var CURRENCY_SYMBOL = {
      CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$',
      KRW: '₩', INR: '₹', SGD: 'S$', TWD: 'NT$', AUD: 'A$', CAD: 'C$',
    }


    // ── i18n ────────────────────────────────────────────────────────────────
    //
    // The locale service owns the active language; we own two dictionaries.
    // Registering bumps its revision, so mounted outlets pick the texts up
    // even though registration happens after they render. Components reached
    // through a slot receive `t` in props (the registration declares
    // `locale: NS`); nested components get it passed down, so a language
    // switch re-renders them the same way.
    var NS = 'dsh-bill'
    var DICT_ZH = {
      'section.title': '费用统计',
      'section.subtitle': '价格 llm-pricing · 汇率 ',
      'view.tab': '费用',
      'settings.desc': '预算在这里设定;完整的费用报告在会话的「费用」标签页。',
      'settings.noScope': '当前客户端没有偏好存储,预算无法保存。',
      'turn.cost': '本轮',
      'turn.steps': ' 步',
      'turn.cache': '缓存命中 ',
      'turn.tipIn': '新增输入 ',
      'turn.tipRead': ' · 缓存读 ',
      'turn.tipWrite': ' · 缓存写 ',
      'turn.tipOut': ' · 输出 ',
      'fx.live': '实时',
      'fx.fixed': '固定',
      'dock.total': '总消耗',
      'dock.session': '本会话',
      'dock.peak': '高峰',
      'dock.report': '报告',
      'dock.tip': '总消耗 / 本会话费用',
      'dock.tipPeak': ' · 高峰 ',
      'dock.tipOffPeak': ' / 低谷 ',
      'dock.tipPeakNote': '(峰谷计价模型)',
      'dock.openReport': '打开费用统计',
      'range.days': '天',
      'range.all': '全部',
      'archived.note': ' · 更早的 %n 次调用已归档为汇总',
      'state.loading': '加载中…',
      'state.loadFailed': '加载失败: ',
      'state.apiError': '接口错误: ',
      'state.empty': '该时间范围内暂无调用记录。',
      'kpi.total': '总费用',
      'kpi.totalHint': ' 天 · 日均 ',
      'kpi.tokens': 'Token 用量',
      'kpi.input': '输入 ',
      'kpi.output': ' · 输出 ',
      'kpi.calls': '模型调用',
      'kpi.models': ' 个模型',
      'kpi.cacheHit': '缓存命中',
      'kpi.cacheRead': '读 ',
      'kpi.cacheWrite': ' · 写 ',
      'kpi.forecast': '预计月度',
      'kpi.forecastHint.a': '按 ',
      'kpi.forecastHint.b': ' 天实测速率外推 30 天',
      'kpi.balance': '账户余额',
      'kpi.balanceHint.a': '赠金 ',
      'kpi.balanceHint.b': ' · 充值 ',
      'kpi.peakShare': '高峰占比',
      'kpi.peakExtra.a': '多付 ',
      'kpi.peakExtra.b': ' · 错峰可省',
      'kpi.peakHint.a': '高峰 ',
      'kpi.peakHint.b': ' · 低谷 ',
      'budget.title': '预算',
      'budget.desc': '设定额度后,这里显示用掉多少;超过 80% 变黄,超支变红。',
      'budget.amount': '额度',
      'budget.period.day': '每日',
      'budget.period.month': '每月',
      'budget.period.all': '累计',
      'budget.used': '已用 ',
      'budget.of': ' / ',
      'budget.left': '剩余 ',
      'budget.over': '超支 ',
      'budget.off': '未设置',
      'budget.set': '设置预算',
      'budget.clear': '清除',
      'sidebar.today': '今日',
      'sidebar.open': '打开费用统计',
      'session.title': '按会话费用',
      'session.untitled': '未命名会话',
      'session.calls': ' 次',
      'attr.title': '成本归因',
      'attr.desc': '按内容类型拆分。每次请求为完整上下文计费,历史内容重复计价。',
      'attr.covered': '已覆盖 ',
      'attr.coveredTail': '),早期记录无归因数据。',
      'attr.attributed': '已归因',
      'attr.back': '← 返回',
      'attr.ofCategory': ' · 占本类 ',
      'overhead.title': '循环开销',
      'overhead.desc': '压缩上下文与生成标题的调用,占账单 ',
      'purpose.compaction': '上下文压缩',
      'purpose.session-title': '会话标题',
      'model.title': '按模型费用',
      'model.col': '模型',
      'model.calls': '调用',
      'model.input': '输入',
      'model.output': '输出',
      'model.cost': '费用',
      'model.peak': '高峰 ',
      'daily.title': '每日费用',
      'daily.calls': ' 次调用',
      'daily.empty': '该范围内没有按日数据',
      'heat.title': '周 × 小时热力图(UTC)',
      'heat.calls': ' 次',
      'footnote': '费用为估算值。未收录的模型标记为「?」,不参与合计;基础单价按模型官方定价货币显示。',
      'cat.tool-read': '工具输出',
      'cat.model': '模型输出',
      'cat.system': '系统提示词',
      'cat.terminal': '终端命令',
      'cat.tool-write': '工具输入',
      'cat.media': '附件',
      'cat.scaffold': '系统提醒',
      'cat.user': '用户输入',
      'detail.prompt.system': '系统提示词',
      'detail.prompt.tools': '工具 schema',
      'detail.model.reply.carried': '历史回复',
      'detail.model.thinking.carried': '历史思考',
      'detail.model.tool-args': '调用参数',
      'detail.model.reply': '本次回复',
      'detail.model.thinking': '本次思考',
      'detail.user.typed': '用户输入',
      'detail.scaffold.reminder': '系统提醒',
      'detail.media.attachment': '附件',
      'detail.tool.unknown': '未知工具',
      'detail.other': '其他',
      'weekday.0': '日',
      'weekday.1': '一',
      'weekday.2': '二',
      'weekday.3': '三',
      'weekday.4': '四',
      'weekday.5': '五',
      'weekday.6': '六',
    }
    var DICT_EN = {
      'section.title': 'Cost',
      'section.subtitle': 'Priced by llm-pricing · FX ',
      'view.tab': 'Cost',
      'settings.desc': 'The budget is set here; the full report is the session\'s "Cost" tab.',
      'settings.noScope': 'This client has no preference store, so a budget cannot be saved.',
      'turn.cost': 'This turn',
      'turn.steps': ' steps',
      'turn.cache': 'cache hit ',
      'turn.tipIn': 'Fresh input ',
      'turn.tipRead': ' · cache read ',
      'turn.tipWrite': ' · cache write ',
      'turn.tipOut': ' · output ',
      'fx.live': 'live',
      'fx.fixed': 'fixed',
      'dock.total': 'Total',
      'dock.session': 'Session',
      'dock.peak': 'Peak',
      'dock.report': 'Report',
      'dock.tip': 'Total spend / this session',
      'dock.tipPeak': ' · peak ',
      'dock.tipOffPeak': ' / off-peak ',
      'dock.tipPeakNote': ' (models with peak pricing)',
      'dock.openReport': 'Open the cost report',
      'range.days': 'd',
      'range.all': 'All',
      'archived.note': ' · %n earlier calls archived as totals',
      'state.loading': 'Loading…',
      'state.loadFailed': 'Failed to load: ',
      'state.apiError': 'API error: ',
      'state.empty': 'No model calls in this range.',
      'kpi.total': 'Total cost',
      'kpi.totalHint': ' days · ',
      'kpi.tokens': 'Tokens',
      'kpi.input': 'in ',
      'kpi.output': ' · out ',
      'kpi.calls': 'Calls',
      'kpi.models': ' models',
      'kpi.cacheHit': 'Cache hit',
      'kpi.cacheRead': 'read ',
      'kpi.cacheWrite': ' · write ',
      'kpi.forecast': 'Monthly est.',
      'kpi.forecastHint.a': 'extrapolated from ',
      'kpi.forecastHint.b': ' observed days',
      'kpi.balance': 'Balance',
      'kpi.balanceHint.a': 'granted ',
      'kpi.balanceHint.b': ' · topped up ',
      'kpi.peakShare': 'Peak share',
      'kpi.peakExtra.a': 'premium ',
      'kpi.peakExtra.b': ' · avoidable off-peak',
      'kpi.peakHint.a': 'peak ',
      'kpi.peakHint.b': ' · off-peak ',
      'budget.title': 'Budget',
      'budget.desc': 'Set a limit and this shows how much of it is gone; amber past 80%, red when over.',
      'budget.amount': 'Limit',
      'budget.period.day': 'Daily',
      'budget.period.month': 'Monthly',
      'budget.period.all': 'All time',
      'budget.used': 'used ',
      'budget.of': ' / ',
      'budget.left': 'left ',
      'budget.over': 'over by ',
      'budget.off': 'not set',
      'budget.set': 'Set a budget',
      'budget.clear': 'Clear',
      'sidebar.today': 'Today',
      'sidebar.open': 'Open the cost report',
      'session.title': 'By session',
      'session.untitled': 'Untitled session',
      'session.calls': ' calls',
      'attr.title': 'Cost attribution',
      'attr.desc': 'Split by content type. Every request pays for the whole context again, so carried content is billed repeatedly.',
      'attr.covered': 'covered ',
      'attr.coveredTail': '); earlier records carry no attribution data.',
      'attr.attributed': 'Attributed',
      'attr.back': '← back',
      'attr.ofCategory': ' · of category ',
      'overhead.title': 'Loop overhead',
      'overhead.desc': 'Compaction and session-title calls, ',
      'purpose.compaction': 'Compaction',
      'purpose.session-title': 'Session title',
      'model.title': 'By model',
      'model.col': 'Model',
      'model.calls': 'Calls',
      'model.input': 'In',
      'model.output': 'Out',
      'model.cost': 'Cost',
      'model.peak': 'peak ',
      'daily.title': 'Daily cost',
      'daily.calls': ' calls',
      'daily.empty': 'No daily data in this range',
      'heat.title': 'Weekday x hour (UTC)',
      'heat.calls': ' calls',
      'footnote': 'Costs are estimates. Models with no listed price are marked "?" and excluded from totals; base rates are shown in each vendor\'s own pricing currency.',
      'cat.tool-read': 'Tool output',
      'cat.model': 'Model output',
      'cat.system': 'System prompt',
      'cat.terminal': 'Shell commands',
      'cat.tool-write': 'Tool input',
      'cat.media': 'Attachments',
      'cat.scaffold': 'Reminders',
      'cat.user': 'What you typed',
      'detail.prompt.system': 'System prompt',
      'detail.prompt.tools': 'Tool schemas',
      'detail.model.reply.carried': 'Past replies',
      'detail.model.thinking.carried': 'Past thinking',
      'detail.model.tool-args': 'Call arguments',
      'detail.model.reply': 'This reply',
      'detail.model.thinking': 'This thinking',
      'detail.user.typed': 'What you typed',
      'detail.scaffold.reminder': 'Reminders',
      'detail.media.attachment': 'Attachments',
      'detail.tool.unknown': 'Unknown tool',
      'detail.other': 'Other',
      'weekday.0': 'Su',
      'weekday.1': 'Mo',
      'weekday.2': 'Tu',
      'weekday.3': 'We',
      'weekday.4': 'Th',
      'weekday.5': 'Fr',
      'weekday.6': 'Sa',
    }
    /** Used before the locale service is reached, and for nested call sites. */
    function fallbackT(key) { return DICT_ZH[key] === undefined ? key : DICT_ZH[key] }
    /** Set in apply() once the locale service is known; drives the DOM label lookup. */
    var translate = fallbackT

    // ── formatters ──────────────────────────────────────────────────────────
    /**
     * Rate table used before the host answers — and, in `TurnCost`, the only
     * one it ever has, since that component never fetches.
     *
     * One constant rather than a literal per call site: this is `DEFAULT_FX`
     * from lib/pricing.js (a dated CFETS parity), so it is a value with a
     * provenance and an expiry, and it was being hand-copied into five places.
     */
    var FX_FALLBACK = { CNY: 6.7878, USD: 1 }

    /** The fx table off a host payload, or the fallback. */
    function fxOf(payload) {
      return payload && typeof payload.fx === 'object' && payload.fx !== null ? payload.fx : FX_FALLBACK
    }

    /**
     * Share of the prompt that was served from cache.
     *
     * "Cache hit" is a definition, not an expression — which of the three
     * disjoint input buckets sit in the denominator is a decision. Stated once
     * so the per-turn line and the report's KPI card cannot drift into
     * disagreeing about it in the same UI.
     */
    function cacheHitPct(read, fresh, write) {
      var prompt = (read || 0) + (fresh || 0) + (write || 0)
      return prompt > 0 ? Math.round((read || 0) / prompt * 100) : null
    }

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
    /**
     * Click the control inside `root` whose visible label is `label`, unless
     * `activeAttr` already marks it current. Returns whether one was found.
     *
     * The single statement of what counts as a legitimate anchor: a SCOPED
     * root, a structural selector, an exact label match, and an
     * already-active check so a click is never a toggle. Both navigation
     * helpers below route through it, so the rule is written once instead of
     * once per helper at two different fidelities — the earlier version of
     * `openBillView` scanned every `<button>` in the document, which any
     * unrelated control with the same text could win.
     */
    function clickLabelled(root, selector, label, activeAttr) {
      if (!root) return false
      var controls = [].slice.call(root.querySelectorAll(selector))
      for (var i = 0; i < controls.length; i++) {
        if ((controls[i].textContent || '').trim() !== label) continue
        if (controls[i].getAttribute(activeAttr) !== 'true') controls[i].click()
        return true
      }
      return false
    }

    /**
     * Retry `attempt` across a bounded number of animation frames.
     *
     * React commits asynchronously, so a panel opened this tick has no rows
     * until the next one; polling frames beats guessing a delay.
     */
    function retryFrames(attempt, tries) {
      var left = tries
      var tick = function () {
        if (attempt()) return
        if (--left > 0) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }

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
        retryFrames(function () {
          return clickLabelled(dialogOf(), 'nav button', label, 'aria-current')
        }, 30)
      } catch (e) { /* never break the composer over a convenience link */ }
    }

    /**
     * Switch the session to the cost view tab.
     *
     * Which view is active is per-session state owned by the conversation
     * shell's own store: `createChatStore`'s `setView`, whose only call sites
     * are inside ui-conversation. There is no cross-plugin navigation verb —
     * `ctx.layout` is sidebar/details only, the `conversation.session` inject
     * share deliberately exposes `{ list, subscribe, version }` without a
     * setter, and no client event carries navigation. (`ctx.conversationViews`
     * is a name trap: it registers snapshot builders, not the tab ring.) So
     * the tab strip's own `role="tablist"` / `role="tab"` markup is the anchor,
     * and clicking is the same affordance the user has. Failure is a no-op.
     */
    function openBillView(label) {
      try {
        return clickLabelled(
          document.querySelector('[role="tablist"]'), '[role="tab"]', label, 'aria-selected',
        )
      } catch (e) { /* never break the composer over a convenience link */ }
      return false
    }

    /**
     * The budget, persisted through the settings scope.
     *
     * A budget the user cannot set without editing YAML is half a feature, so
     * it lives in the same preference store the shipped settings pages use:
     * written from the UI, resolved by the host, and shared across windows.
     * The scope is optional — without it the budget section simply does not
     * render, rather than pretending to save.
     */
    var budgetScope = null
    function useBudget() {
      var state = React.useState({ amount: 0, period: 'month', currency: 'CNY' })
      var value = state[0]
      var setValue = state[1]
      React.useEffect(function () {
        if (!budgetScope) return
        var read = function () {
          var snap = budgetScope.getSnapshot()
          var v = (snap && snap.value) || {}
          setValue({
            amount: Number(v.budgetAmount) > 0 ? Number(v.budgetAmount) : 0,
            period: v.budgetPeriod === 'day' || v.budgetPeriod === 'all' ? v.budgetPeriod : 'month',
            currency: typeof v.budgetCurrency === 'string' ? v.budgetCurrency : 'CNY',
          })
        }
        read()
        var stop = budgetScope.subscribe(read)
        if (typeof budgetScope.load === 'function') budgetScope.load()
        return stop
      }, [])
      var write = function (patch) {
        setValue(function (prev) { return { ...prev, ...patch } })
        if (!budgetScope) return
        if (patch.amount !== undefined) budgetScope.set('budgetAmount', patch.amount)
        if (patch.period !== undefined) budgetScope.set('budgetPeriod', patch.period)
        if (patch.currency !== undefined) budgetScope.set('budgetCurrency', patch.currency)
      }
      return [value, write]
    }

    // ── host transport ──────────────────────────────────────────────────────
    //
    // Two carriers, tried in that order, for the same `{ action, ... }` body:
    //
    //   1. The Connection RPC channel `/dsh-bill`. It rides whatever transport
    //      the client is already connected over instead of assuming the page
    //      was served by an HTTP host, so the report works in a client
    //      generation where a bare `fetch('/dsh-bill/api')` has nowhere to go.
    //   2. That same POST, for a host without the channel.
    //
    // The choice is made once (`rpcChannel` is resolved in apply and never
    // changes for the page's lifetime), so this is a branch, not a probe.
    var rpcChannel = null
    function callBill(payload) {
      if (rpcChannel) {
        return rpcChannel.call('/dsh-bill', payload.action, payload).then(function (result) {
          if (result && result.ok) return result.value
          var error = result && result.error
          throw new Error(error && error.message ? error.message : 'rpc failed')
        })
      }
      return fetch('/dsh-bill/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json() })
    }

    /**
     * Poll interval for the figures no projection can push.
     *
     * The per-session numbers arrive through `useProjection` the moment a turn
     * closes, so nothing here needs to be quick any more: what is left is
     * whole-history aggregation, which changes on the same events the
     * projection already reports. `revision` (below) refetches on exactly
     * those, and this interval is only the floor that catches spend from
     * ANOTHER window — the case no local event covers.
     */
    var POLL_MS = 30000

    /**
     * Read one host action, refetching on `deps`, on `revision`, and on a slow
     * timer. A caller that wants "refetch when a turn finishes" puts the
     * projection's closed-turn count in `deps` like any other dependency —
     * there is no second mechanism for it.
     */
    function useCostApi(action, deps) {
      var state = React.useState({ loading: true, data: null, error: null })
      var data = state[0]
      var setData = state[1]
      React.useEffect(function () {
        var alive = true
        function load() {
          callBill(action()).then(function (json) {
            if (alive) setData({ loading: false, data: json, error: null })
          }).catch(function (e) {
            if (alive) setData({ loading: false, data: null, error: e && e.message ? e.message : String(e) })
          })
        }
        load()
        var timer = setInterval(load, POLL_MS)
        return function () { alive = false; clearInterval(timer) }
      }, deps)
      return data
    }

    /**
     * The current session's cost, pushed by the host's `billTurns` projection.
     *
     * No fetch and no timer: the framework seeds the value from the history
     * tail page and updates it with a `session/projection` frame whenever the
     * fold changes. `undefined` means the capability is absent (an older host,
     * or the unit unloaded) — every caller falls back rather than showing 0.
     *
     * `select` narrows to the slice a component actually renders. That matters
     * because the projection updates twice per STEP: without a selector every
     * subscriber re-renders on every usage report, and a conversation with 400
     * turn-tails re-renders all of them to reflect a change to one.
     */
    function useBillTurns(props, select, eq) {
      if (typeof props.useProjection !== 'function') return select ? select(undefined) : undefined
      return select ? props.useProjection('billTurns', select, eq) : props.useProjection('billTurns')
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
    //
    // Geometry lives in `.dshbill-dock`, copied from the shipped StatsLine's
    // own rule — see the sheet for why it is 12px/20px rather than a ramp step.
    var costRow = { display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', textAlign: 'center' }
    var costLabel = { color: T.label3 }
    var costValue = { color: T.label, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }
    /** Separator tone taken from StatsLine's `.sep`, not a dimmed label. */
    var costSep = { color: T.sep }

    /** Dock slice: the session total, and a turn count to key the refetch on. */
    function dockSelect(value) {
      if (!value) return { usd: undefined, turns: 0 }
      return { usd: value.totalUsd, turns: value.turns ? value.turns.length : 0 }
    }
    function dockEq(a, b) { return a.usd === b.usd && a.turns === b.turns }

    function CostLine(props) {
      var t = props.t || fallbackT
      var sessionId = props.sessionId || (props.session && props.session.sessionId)
      var currency = 'CNY'
      // The session half comes from the projection: pushed the moment a turn
      // closes, derived from the durable log (so it covers turns from before
      // this plugin was installed), and free of a timer. The all-time half has
      // no projection — it spans every session — so it is fetched.
      //
      // Narrowed to the two fields this line renders, and the refetch is keyed
      // on the number of TURNS rather than on `calls`: `calls` counts model
      // calls, so a 20-step turn would tear down the interval and re-request
      // the all-time total twenty times, and the slow poll underneath would
      // never survive long enough to fire.
      var session = useBillTurns(props, dockSelect, dockEq)
      var state = useCostApi(function () {
        return { action: 'overview', sessionId: sessionId }
      }, [sessionId, session.turns])
      if (!sessionId || state.loading || !state.data) return null
      var d = state.data
      if (d.error || d.totalUsd === undefined || d.totalUsd === null) return null
      if (d.totalUsd <= 0) return null
      var fx = fxOf(d)
      // The projection is preferred whenever the capability is present, NOT
      // whenever it happens to be fully priced: gating on `priced` let a
      // single unlisted model silently swap which system produced the figure,
      // so the same line meant two different things on different days.
      var sessionUsd = session.usd === undefined ? d.sessionUsd : session.usd

      var items = [
        el('span', { key: 'tl', style: costLabel }, t('dock.total')),
        el('span', { key: 'tv', style: costValue }, fmtCost(d.totalUsd, currency, fx)),
        el('span', { key: 'sep1', style: costSep }, '·'),
        el('span', { key: 'sl', style: costLabel }, t('dock.session')),
        el('span', { key: 'sv', style: costValue }, fmtCost(sessionUsd, currency, fx)),
      ]
      var peak = peakShare(d)
      var title = t('dock.tip')
      if (peak) {
        items.push(el('span', { key: 'sep2', style: costSep }, '·'))
        items.push(el('span', { key: 'pl', style: costLabel }, t('dock.peak')))
        items.push(el('span', { key: 'pv', style: costValue }, peak.pct + '%'))
        title += t('dock.tipPeak') + fmtCost(peak.peakUsd, currency, fx)
          + t('dock.tipOffPeak') + fmtCost(peak.offPeakUsd, currency, fx) + t('dock.tipPeakNote')
      }

      items.push(el('span', { key: 'sep3', style: costSep }, '·'))
      items.push(el('button', {
        key: 'report',
        type: 'button',
        className: 'dshbill-link',
        title: t('dock.openReport'),
        onClick: function () { openBillView(translate('view.tab')) },
      }, t('dock.report')))

      return el('div', { className: 'dshbill-dock', title: title },
        el('div', { style: costRow }, items))
    }

    // ── 1a. per-turn cost, in the turn it belongs to ────────────────────────
    //
    // The dock says what the conversation costs and the report says where the
    // month went; neither answers the question a user actually acts on, which
    // is "which turn was expensive?". A session total that moves from ¥1.90 to
    // ¥2.40 tells you nothing about what you did; a line under the turn that
    // says ¥0.50 tells you it was the one where you pasted the log file.
    //
    // The numbers come from the `billTurns` projection, so they are the
    // provider's own usage report for that exact turn — not this plugin's
    // capture, which cannot see turn boundaries at all (see lib/projection.js).
    //
    // Contract: `conversation.chat.turnTail` is a CHAIN, and `select` must be
    // pure over the owner props — it may not read the projection. So it routes
    // on the turn being closed (an open turn has no final usage to report) and
    // the component renders nothing while the value has not landed. That is
    // the one thing the seat asks entries not to do, and it is unavoidable
    // here: whether a turn has a cost is not knowable from its identity.
    //
    // 13/20 with a 2px vertical pad, which is what the shipped turn-tail entry
    // (`TurnMaxTokensItem`) renders at. This line used to be 11/16 — two steps
    // below anything else in the band, which read as a footnote about the
    // conversation rather than as part of it.
    var turnCostRow = {
      display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      padding: '2px 0', color: T.label3,
      ...numeric(F.xs),
    }
    /** The turn's own figure. Hoisted: one `TurnCost` renders per turn. */
    var turnCostValue = { color: T.label, ...N.xsStrong }

    /**
     * Index of turn number → wire row, rebuilt only when the array identity
     * changes.
     *
     * `apply` replaces exactly one row per event and carries the rest across by
     * reference, so the array is a new object on each push but its contents are
     * mostly the same. Without an index every mounted turn-tail scanned the
     * whole row list on every render — quadratic in the number of turns, twice
     * per step. A WeakMap keyed on the array holds no reference of its own.
     */
    var turnIndexCache = new WeakMap()
    function turnRowOf(value, wanted) {
      var rows = value && value.turns
      if (!rows || !rows.length) return null
      var index = turnIndexCache.get(rows)
      if (index === undefined) {
        index = new Map()
        for (var i = 0; i < rows.length; i++) index.set(rows[i].turn, rows[i])
        turnIndexCache.set(rows, index)
      }
      return index.get(wanted) || null
    }

    function TurnCost(props) {
      var t = props.t || fallbackT
      var wanted = props.matched && props.matched.turn
      // Narrowed to this turn's own row, so a usage report for ANOTHER turn
      // does not re-render this one. The equality test is row identity, which
      // is exactly the granularity `apply` preserves.
      var row = useBillTurns(
        props,
        React.useCallback(function (value) { return turnRowOf(value, wanted) }, [wanted]),
      )
      // No row means the turn aged out of the capped list, or it made no model
      // call at all (a rejected or empty turn). Both are "nothing to say".
      if (!row || row.usd === null || !(row.usd > 0)) return null

      var currency = 'CNY'
      var fx = FX_FALLBACK
      var cacheHit = cacheHitPct(row.cacheReadTokens, row.inputTokens, row.cacheWriteTokens)
      var items = [
        el('span', { key: 'l' }, t('turn.cost')),
        el('span', { key: 'v', style: turnCostValue }, fmtCost(row.usd, currency, fx)),
      ]
      if (row.calls > 1) {
        items.push(el('span', { key: 's1', style: costSep }, '·'))
        items.push(el('span', { key: 'c' }, row.calls + t('turn.steps')))
      }
      // A high cache-hit rate is the single most actionable number here: it is
      // what collapses when a turn rewrites the top of its own context.
      if (cacheHit !== null) {
        items.push(el('span', { key: 's2', style: costSep }, '·'))
        items.push(el('span', { key: 'h' }, t('turn.cache') + cacheHit + '%'))
      }
      var title = t('turn.tipIn') + fmtTokens(row.inputTokens)
        + t('turn.tipRead') + fmtTokens(row.cacheReadTokens)
        + t('turn.tipWrite') + fmtTokens(row.cacheWriteTokens)
        + t('turn.tipOut') + fmtTokens(row.outputTokens)
        + (row.displayName ? ' · ' + row.displayName : '')
      return el('div', { style: turnCostRow, title: title }, items)
    }

    // ── 1b. sidebar footer: today's spend, always visible ───────────────────
    //
    // The report is a place you go to; this is a thing you see. One line above
    // the settings button showing today against the budget, so overspending is
    // noticed on the day rather than discovered at the end of the month.
    //
    // The sidebar collapses to a rail, where `wide` goes false — then it
    // degrades to the percentage alone rather than clipping a currency string.
    //
    // Geometry is the settings trigger's, its only neighbour in the footer:
    // 34px tall, 12px radius, the same `4px -4px` bleed so it lines up with the
    // nav cells above, a hover fill, and a 36px circle in the rail. It was a
    // flat 12px caption with no hover — the one thing in that column that did
    // not look pressable, while being the only thing there that was.
    function SidebarSpend(props) {
      var t = props.t || fallbackT
      var wide = props.wide !== false
      // `periods` rather than `dashboard`: this line needs day/month/all-time
      // and nothing else, and asking for the report built a timeline, heatmap,
      // attribution tree and forecast over the whole ring to be thrown away.
      var state = useCostApi(function () { return { action: 'periods' } }, [])
      var budgetPair = useBudget()
      var budget = budgetPair[0]
      var d = state.data
      if (!d || d.error || !d.periods) return null
      var fx = fxOf(d)
      var todayUsd = d.periods.day || 0
      if (!(todayUsd > 0) && !(budget.amount > 0)) return null

      var spent = budget.amount > 0 ? convert(d.periods[budget.period] ?? 0, budget.currency, fx) : null
      var pct = budget.amount > 0 && spent !== null ? spent / budget.amount * 100 : null
      var color = pct === null ? T.label2 : pct >= 100 ? T.error : pct >= 80 ? T.warn : T.label2

      return el('button', {
        type: 'button',
        className: 'dshbill-spend',
        'data-rail': wide ? undefined : 'true',
        title: t('sidebar.open'),
        // The report lives in a session view tab; the settings page is the
        // fallback for the sidebar's own root scope, where no session — and so
        // no tab bar — need exist.
        onClick: function () {
          if (!openBillView(translate('view.tab'))) openSettingsSection(translate('section.title'))
        },
        style: { color: color, ...F.xs },
      },
        wide ? el('span', { style: { color: T.label3, flexShrink: 0 } }, t('sidebar.today')) : null,
        wide
          ? el('span', { style: N.xsStrong },
              fmtCost(todayUsd, budget.currency || 'CNY', fx))
          : null,
        pct !== null
          ? el('span', {
              style: { marginLeft: wide ? 'auto' : 0, flexShrink: 0, ...N.xxs },
            }, Math.round(pct) + '%')
          : null)
    }

    // ── 2. settings.section dashboard ────────────────────────────────────────
    //
    // Layout note: this page renders inside the settings dialog, whose content
    // column is ~500px wide. Everything below is designed for that width — a
    // wide-screen layout (multi-column grids, side-by-side charts, a Marimekko
    // with eight labelled columns) collapses into unreadable slivers there.
    //
    // Visual language follows the shipped settings pages, whose vocabulary is
    // narrow and worth restating exactly: a 16/24 weight-500 page title over a
    // 14/22 tertiary intro, subsections at 14/22 weight 500 with a 12/18
    // tertiary description, cards outlined in `border-l2` at radius 12 with
    // 12px/14px padding, and every control on the 28px pill. Emphasis is
    // weight 500 throughout — the design system has no 600 outside markdown
    // headings, and this file used to reach for it a dozen times.
    var card = {
      border: '1px solid ' + T.border2, borderRadius: 12, padding: '12px 14px',
      background: T.layer1, boxSizing: 'border-box', minWidth: 0,
    }
    var cardL = { color: T.label2, marginBottom: 4, ...F.xxsStrong }
    var cardV = { color: T.label, ...N.l }
    var cardH = { color: T.label3, marginTop: 2, ...ELLIPSIS, ...F.xxs }
    /** A flat section: hairline above, generous top margin, no box. */
    var section = { marginTop: 20, paddingTop: 16, borderTop: '1px solid ' + T.border, boxSizing: 'border-box', minWidth: 0 }
    var panelT = { color: T.label, marginBottom: 2, ...F.sStrong }
    var panelSub = { color: T.label3, marginBottom: 12, ...F.xxs }
    /** The page title and its one-line intro, shared by the tab and settings. */
    var pageT = { color: T.label, ...F.baseStrong }
    var pageSub = { color: T.label3, marginTop: 2, ...ELLIPSIS, ...F.s }
    /** Body copy for a status line (loading / empty / failed). */
    var stateLine = { color: T.label3, padding: '20px 0', ...F.s }
    /** The same line when it is reporting a failure, tighter and in red. */
    var errorLine = { ...stateLine, color: T.error, padding: '8px 0' }
    /** …and when it is reporting "no data", which is not a failure. */
    var emptyLine = { ...stateLine, padding: '8px 0' }

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
    /**
     * Detail keys written before the ids existed.
     *
     * Early records stored the Chinese label itself as the key. Those rows are
     * immortal — history is never re-priced or rewritten — so without this map
     * an upgraded install shows two vocabularies side by side forever, and the
     * English UI shows Chinese for the older half of the bill.
     */
    var LEGACY_DETAIL = {
      '系统提示词': 'prompt.system',
      '工具 schema': 'prompt.tools',
      '助手文字（作为输入重新计费）': 'model.reply.carried',
      '思考块（作为输入重新计费）': 'model.thinking.carried',
      '工具调用参数': 'model.tool-args',
      '助手文字（生成）': 'model.reply',
      '思考': 'model.thinking',
      '我敲的字': 'user.typed',
      '框架': 'scaffold.reminder',
      '媒体': 'media.attachment',
      '未知工具': 'tool.unknown',
    }
    function catLabel(t, cat) { return t('cat.' + cat) }
    /**
     * Fixed details resolve through the dictionary; tool names and shell
     * programs (`read`, `git`, an MCP tool id) pass through untranslated —
     * they are identifiers, not copy.
     */
    function detailLabel(t, sub) {
      var id = LEGACY_DETAIL[sub] || sub
      var text = t('detail.' + id)
      return text === 'detail.' + id ? sub : text
    }
    /**
     * A child row's label, including the folded tail's own count.
     *
     * The tail arrives as a flag and a number rather than a rendered phrase, so
     * the count has to be composed here — which also means it composes in
     * whichever language is active. `folded` is the discriminator, not the row's
     * `sub`: that keeps the detail-id namespace free of a reserved word, and
     * keeps `detailLabel`'s "unknown id falls through to itself" rule from ever
     * showing a user the bare string `other`.
     */
    function childLabel(t, child) {
      if (child.folded) return t('detail.other') + ' (' + child.count + ')'
      return detailLabel(t, child.sub)
    }
    function purposeLabel(t, purpose) {
      var text = t('purpose.' + purpose)
      return text === 'purpose.' + purpose ? purpose : text
    }

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
      var t = props.t || fallbackT
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
          name: catLabel(t, row.cat), onClick: function () { props.onFocus(focus === row.cat ? null : row.cat) },
        })
        var childTotal = (row.children || []).reduce(function (s, c) { return s + c.usd }, 0)
        var childAngle = angle
        ;(row.children || []).forEach(function (child, i) {
          var childSweep = childTotal > 0 ? child.usd / childTotal * sweep : 0
          arcs.push({
            key: 'd:' + row.cat + ':' + child.sub,
            d: arcPath(cx, cy, r1 + 2, r2, childAngle, childAngle + childSweep),
            fill: color, opacity: 0.82 - (i % 4) * 0.16, cat: row.cat, usd: child.usd,
            name: childLabel(t, child),
            onClick: function () { props.onFocus(focus === row.cat ? null : row.cat) },
          })
          childAngle += childSweep
        })
        angle += sweep
      })

      // Centre readout: whatever is hovered, else the drilled-in category, else
      // the whole attributed bill.
      var centreName = hover ? hover.name : focused ? catLabel(t, focused.cat) : t('attr.attributed')
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
              className: 'dshbill-arc',
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
            x: cx, y: cy - 8, textAnchor: 'middle', fill: T.label3,
            style: { pointerEvents: 'none', ...F.xxs },
          }, centreName),
          el('text', {
            x: cx, y: cy + 12, textAnchor: 'middle', fill: T.label,
            style: { pointerEvents: 'none', ...N.baseStrong },
          }, props.fmt(centreUsd)),
          el('text', {
            x: cx, y: cy + 28, textAnchor: 'middle', fill: T.label3,
            style: { pointerEvents: 'none', ...F.xxs },
          }, focused ? t('attr.back') : centrePct + '%')))
    }

    /**
     * Budget: a limit, a period, and how much of it is gone.
     *
     * The limit is stored in the currency it was typed in, not converted at
     * write time — "¥100 a month" must stay ¥100 when the display currency
     * changes, and a stored USD equivalent would drift with the exchange rate.
     */
    function BudgetSection(props) {
      var t = props.t
      var budget = props.budget
      var setBudget = props.setBudget
      var spentUsd = props.spentUsd
      var fx = props.fx
      var editing = React.useState(false)
      var isEditing = editing[0]
      var setEditing = editing[1]

      var sym = CURRENCY_SYMBOL[budget.currency] || (budget.currency + ' ')
      var spent = convert(spentUsd, budget.currency, fx)
      var pct = budget.amount > 0 && spent !== null ? spent / budget.amount * 100 : null
      var level = pct === null ? 'ok' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
      var barColor = level === 'over' ? T.error : level === 'warn' ? T.warn : T.business

      var periods = ['day', 'month', 'all']
      var editor = el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
        el('span', { className: 'dshbill-seg' }, periods.map(function (p) {
          return el('button', {
            key: p,
            type: 'button',
            'data-on': budget.period === p ? 'true' : undefined,
            onClick: function () { setBudget({ period: p }) },
          }, t('budget.period.' + p))
        })),
        el('input', {
          type: 'number', min: 0, step: 1, value: budget.amount || '',
          className: 'dshbill-field',
          onChange: function (e) {
            var n = Number(e.target.value)
            setBudget({ amount: Number.isFinite(n) && n > 0 ? n : 0, currency: props.currency })
          },
          style: { width: 92 },
        }),
        el('span', { style: { color: T.label3, ...F.xxs } }, budget.currency),
        budget.amount > 0
          ? el('button', {
              type: 'button',
              className: 'dshbill-btn dshbill-btn-quiet',
              onClick: function () { setBudget({ amount: 0 }); setEditing(false) },
            }, t('budget.clear'))
          : null)

      if (!(budget.amount > 0) && !isEditing) {
        return el('div', { style: section },
          el('div', { style: panelT }, t('budget.title')),
          el('div', { style: panelSub }, t('budget.desc')),
          el('button', {
            type: 'button',
            className: 'dshbill-btn',
            onClick: function () { setEditing(true) },
          }, t('budget.set')))
      }

      var remaining = spent === null ? null : budget.amount - spent
      return el('div', { style: section },
        el('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          el('div', { style: { ...panelT, marginBottom: 0 } }, t('budget.title')),
          el('span', { style: { color: T.label3, ...F.xxs } }, t('budget.period.' + budget.period)),
          el('span', {
            style: {
              marginLeft: 'auto',
              color: level === 'over' ? T.error : T.label,
              ...N.xxsStrong,
            },
          }, t('budget.used') + sym + (spent === null ? '—' : spent.toFixed(2))
             + t('budget.of') + sym + budget.amount.toFixed(2))),
        // 999px, like every other progress track in the shell.
        el('div', { style: { height: 6, borderRadius: 999, background: T.hover, overflow: 'hidden', marginTop: 8 } },
          el('div', {
            style: {
              width: Math.min(100, pct === null ? 0 : pct) + '%', height: '100%',
              background: barColor, transition: 'width .2s ' + T.ease,
            },
          })),
        el('div', { style: { color: T.label3, marginTop: 4, ...N.xxs } },
          pct === null ? t('budget.off')
            : (remaining >= 0 ? t('budget.left') + sym + remaining.toFixed(2) : t('budget.over') + sym + (-remaining).toFixed(2))
              + ' · ' + Math.round(pct) + '%'),
        isEditing || budget.amount > 0 ? editor : null)
    }

    // Hoisted because `AttributionRow` renders once per category and its inner
    // block once per detail — a few hundred style objects per report pass if
    // they are rebuilt in place. Only the swatch colour and the bar width
    // actually vary, and those two stay inline below.
    var attrHead = { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }
    var attrName = { color: T.label, minWidth: 0, ...ELLIPSIS, ...F.xxsStrong }
    var attrPct = { color: T.label3, flexShrink: 0, ...N.xxs }
    var attrTotal = { marginLeft: 'auto', color: T.label, flexShrink: 0, ...N.xxsStrong }
    var attrChildren = { marginLeft: 16, marginTop: 4 }
    var attrChildRow = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 3 }
    var attrChildName = { color: T.label2, flex: '0 0 38%', minWidth: 0, ...ELLIPSIS, ...F.xxs }
    /** The folded tail row reads as a summary, so it is set in italic. */
    var attrChildNameFolded = { ...attrChildName, fontStyle: 'italic' }
    var attrTrack = { flex: '1 1 auto', height: 4, borderRadius: 999, background: T.hover, overflow: 'hidden', minWidth: 0 }
    var attrChildValue = { color: T.label2, flexShrink: 0, minWidth: 52, textAlign: 'right', ...N.xxs }

    // Per-model table rows, likewise once per model.
    /** A model cell carries two lines, so it overrides the sheet's 30px row. */
    var modelCellTall = { height: 44, paddingTop: 5, paddingBottom: 5 }
    var modelIdentity = { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }
    var modelName = { ...ELLIPSIS, ...F.xxsStrong }
    var modelPct = { flexShrink: 0, color: T.label3, ...F.xxs }
    var modelBaseLine = { color: T.label3, ...ELLIPSIS, ...F.xxxs }
    /** Outlined tag, as on the settings model rows. */
    var unpricedTag = {
      flexShrink: 0, padding: '0 5px', borderRadius: 4,
      border: '1px solid ' + T.border3, color: T.warnLabel, ...F.xxxs,
    }

    // Per-session rows. The header layout and the total are the attribution
    // row's — same shape, same meaning, so the same constants.
    var sessionRow = { marginTop: 8, minWidth: 0 }
    var sessionName = { color: T.label, minWidth: 0, ...ELLIPSIS, ...F.xxs }
    var sessionCalls = { color: T.label3, flexShrink: 0, ...F.xxs }
    var sessionTrack = { height: 4, borderRadius: 999, background: T.hover, overflow: 'hidden', marginTop: 4 }

    /** One category row: header, share, and its details indented under it. */
    function AttributionRow(props) {
      var t = props.t || fallbackT
      var row = props.row
      var color = catColor(row.cat)
      var pct = props.total > 0 ? row.usd / props.total * 100 : 0
      var maxChild = (row.children || []).reduce(function (m, c) { return Math.max(m, c.usd) }, 0)
      var children = (row.children || []).length > 1 ? row.children : []
      var active = props.focus === row.cat
      return el('div', {
        className: 'dshbill-attr',
        'data-on': active ? 'true' : undefined,
        onClick: function () { props.onFocus(active ? null : row.cat) },
      },
        el('div', { style: attrHead },
          // 8px swatch at radius 2, as in the composer's context meter.
          el('span', {
            style: {
              width: 8, height: 8, borderRadius: 2, background: color,
              flexShrink: 0, alignSelf: 'center',
            },
          }),
          el('span', { style: attrName }, catLabel(t, row.cat)),
          el('span', { style: attrPct }, (Math.round(pct * 10) / 10) + '%'),
          el('span', { style: attrTotal }, props.fmt(row.usd))),
        children.length
          ? el('div', { style: attrChildren }, children.map(function (child) {
              var label = childLabel(t, child)
              return el('div', { key: child.sub, style: attrChildRow },
                el('span', {
                  style: child.folded ? attrChildNameFolded : attrChildName,
                  title: label,
                }, label),
                el('div', { style: attrTrack },
                  el('div', {
                    style: {
                      width: (maxChild > 0 ? child.usd / maxChild * 100 : 0) + '%',
                      height: '100%', background: color, opacity: 0.7,
                    },
                  })),
                el('span', { style: attrChildValue }, props.fmt(child.usd)))
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
        className: 'dshbill-field',
        onChange: function (e) { props.onChange(e.target.value) },
        style: { cursor: 'pointer', maxWidth: 130, minWidth: 0 },
      }, options.map(function (code) {
        return el('option', { key: code, value: code },
          (CURRENCY_SYMBOL[code] ? CURRENCY_SYMBOL[code] + ' ' : '') + code)
      }))
    }

    /** One heatmap row: weekday label (fixed 28px) + 24 equal-width cells. */
    function heatmapRow(weekday, cells, cellStyle, titleOf) {
      var label = el('div', {
        style: { width: 28, flexShrink: 0, color: T.label3, display: 'flex', alignItems: 'center', justifyContent: 'center', ...F.xxxs },
      }, weekday === null ? '' : weekday)
      var items = [label]
      for (var h = 0; h < 24; h++) {
        var cell = cells[h]
        items.push(el('div', {
          key: 'h' + h,
          style: { flex: '1 1 0', minWidth: 0, height: 16, marginLeft: h === 0 ? 0 : 2, borderRadius: 4, boxSizing: 'border-box', ...cellStyle(cell) },
          title: titleOf(cell),
        }))
      }
      return el('div', {
        key: 'w' + weekday,
        style: { display: 'flex', alignItems: 'center', marginTop: 2, minWidth: 0 },
      }, items)
    }

    function Dashboard(props) {
      var t = props.t || fallbackT
      // Titles live in the shell's session list; our records only carry ids.
      var sessions = typeof props.useSessions === 'function'
        ? props.useSessions(function (state) { return state && state.byId })
        : null
      var sessionTitle = function (id) {
        var entry = sessions && sessions[id]
        return entry && typeof entry.title === 'string' ? entry.title : ''
      }
      var range = React.useState(30)
      var rangeDays = range[0]
      var setRange = range[1]
      var cur = React.useState('CNY')
      var currency = cur[0]
      var setCurrency = cur[1]
      var budgetPair = useBudget()
      var budget = budgetPair[0]
      var setBudget = budgetPair[1]
      // Which category the sunburst is drilled into (null = the whole bill).
      var focusState = React.useState(null)
      var attrFocus = focusState[0]
      var setAttrFocus = focusState[1]

      var state = useCostApi(function () {
        return { action: 'dashboard', rangeDays: rangeDays }
      }, [rangeDays])
      // Balance is a separate, slower call (it hits the provider), so it is
      // fetched on its own and simply absent until it lands.
      var balanceState = useCostApi(function () { return { action: 'balance' } }, [])
      var d = state.data
      var fx = fxOf(d)
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
        var cacheHit = cacheHitPct(d.cacheReadTokens, d.uncachedInputTokens, d.cacheWriteTokens)
        // Projection uses the days actually observed, not the requested range
        // — two days of history in a 30-day window would otherwise forecast a
        // fifteenth of the real rate.
        var fc = d.forecast || null
        kpis = [
          {
            label: t('kpi.total'),
            value: fmtCost(d.totalUsd, currency, fx),
            hint: (rangeDays > 0 ? rangeDays + t('kpi.totalHint') : '')
              + fmtCost(fc ? fc.perDayUsd : perDay, currency, fx)
              + (d.archived && rangeDays > 0 ? t('archived.note').replace('%n', d.archived.calls) : ''),
          },
          { label: t('kpi.tokens'), value: fmtTokens(d.tokens), hint: t('kpi.input') + fmtTokens(d.uncachedInputTokens) + t('kpi.output') + fmtTokens(d.outputTokens) },
          { label: t('kpi.calls'), value: fmtInt(d.calls), hint: (d.byModel ? d.byModel.length : 0) + t('kpi.models') },
          { label: t('kpi.cacheHit'), value: cacheHit === null ? '—' : cacheHit + '%', hint: t('kpi.cacheRead') + fmtTokens(d.cacheReadTokens) + t('kpi.cacheWrite') + fmtTokens(d.cacheWriteTokens) },
        ]
        var bal = balanceState.data && balanceState.data.balance
        if (bal && bal.ok) {
          // Shown in the account's own currency: a balance is a real figure
          // held by the vendor, not a converted estimate like the spend rows.
          var sym = CURRENCY_SYMBOL[bal.currency] || (bal.currency + ' ')
          kpis.push({
            label: t('kpi.balance'),
            value: sym + bal.total.toFixed(2),
            hint: t('kpi.balanceHint.a') + sym + bal.granted.toFixed(2)
              + t('kpi.balanceHint.b') + sym + bal.toppedUp.toFixed(2),
          })
        }
        if (fc && fc.per30dUsd > 0) {
          kpis.push({
            label: t('kpi.forecast'),
            value: fmtCost(fc.per30dUsd, currency, fx),
            hint: t('kpi.forecastHint.a') + fc.observedDays + t('kpi.forecastHint.b'),
          })
        }
        // Only for models that actually bill peak/off-peak (DeepSeek
        // first-party). Everything else has no peak rate to be a share of.
        var peak = peakShare(d)
        if (peak) {
          // The premium is what those calls cost ABOVE the off-peak card —
          // money already spent that a different schedule would not have.
          var extra = fc ? fc.peakExtraUsd : 0
          kpis.push({
            label: t('kpi.peakShare'),
            value: peak.pct + '%',
            hint: extra > 0
              ? t('kpi.peakExtra.a') + fmtCost(extra, currency, fx) + t('kpi.peakExtra.b')
              : t('kpi.peakHint.a') + fmtCost(peak.peakUsd, currency, fx) + t('kpi.peakHint.b') + fmtCost(peak.offPeakUsd, currency, fx),
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
      // Tinted from the design system's own blue rather than a literal rgba, so
      // the ramp tracks the palette and the empty cell tracks the theme — the
      // hard-coded grey used to sit visibly light on the dark surface.
      function cellStyle(cell) {
        if (cell.usd <= 0 || maxCell <= 0) return { background: T.hover }
        var pct = (15 + 80 * (cell.usd / maxCell)).toFixed(0)
        return {
          background: 'color-mix(in srgb, var(--dsw-static-blue-450, rgb(77,147,248)) '
            + pct + '%, ' + T.layer1 + ')',
        }
      }
      function cellTitle(cell) {
        return cell.hour + ':00 · ' + fmtCost(cell.usd, currency, fx) + ' · ' + cell.calls + t('heat.calls')
      }
      var weekLabels = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return t('weekday.' + i) })
      var hourTicks = [0, 6, 12, 18, 23]

      var maxDay = 0
      if (d && d.timelineDays) {
        for (var j = 0; j < d.timelineDays.length; j++) if (d.timelineDays[j].usd > maxDay) maxDay = d.timelineDays[j].usd
      }

      var fxSourceText = d && d.fxSource === 'live' ? t('fx.live') : t('fx.fixed')

      // The page now has two homes of very different widths: a conversation
      // view tab (the whole centre column) and the settings dialog's ~500px
      // content column. Everything below is fluid, and the cap keeps a
      // full-width tab from stretching a two-column table across a monitor.
      return el('div', {
        style: {
          padding: '16px 24px 8px', width: '100%', maxWidth: 1080, margin: '0 auto',
          boxSizing: 'border-box', minWidth: 0,
        },
      },

        // header
        el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 14, minWidth: 0 } },
          el('div', { style: { minWidth: 0 } },
            el('div', { style: pageT }, t('section.title')),
            el('div', { style: pageSub }, t('section.subtitle') + fxSourceText)),
          el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            el('span', { className: 'dshbill-seg' },
              [7, 30, 90, 365, 0].map(function (days) {
                return el('button', {
                  key: days,
                  type: 'button',
                  'data-on': rangeDays === days ? 'true' : undefined,
                  onClick: function () { setRange(days) },
                }, days === 0 ? t('range.all') : days + t('range.days'))
              })),
            el(CurrencySelect, { value: currency, fx: fx, onChange: setCurrency }))),

        state.loading ? el('div', { style: stateLine }, t('state.loading'))
          : state.error ? el('div', { style: errorLine }, t('state.loadFailed') + state.error)
            : d && d.error ? el('div', { style: errorLine }, t('state.apiError') + d.error)
              : !d || d.calls === 0 ? el('div', { style: stateLine }, t('state.empty'))
                : el('div', null,

                  // KPI — two per row at the settings pane's width, so the
                  // last card never orphans on a row of its own.
                  el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 8 } },
                    kpis.map(function (kpi) {
                      return el('div', { key: kpi.label, style: card },
                        el('div', { style: cardL }, kpi.label),
                        el('div', { style: cardV }, kpi.value),
                        kpi.hint ? el('div', { style: cardH, title: kpi.hint }, kpi.hint) : null)
                    })),

                  // budget — only when the preference store is reachable
                  budgetScope && d.periods
                    ? el(BudgetSection, {
                        t: t, budget: budget, setBudget: setBudget, currency: currency, fx: fx,
                        spentUsd: d.periods[budget.period] ?? 0,
                      })
                    : null,

                  // cost attribution — where the money went, by content kind
                  attr && attr.categories && attr.categories.length
                    ? el('div', { style: section },
                        el('div', { style: panelT }, t('attr.title')),
                        el('div', { style: panelSub },
                          t('attr.desc')
                          + (attrCoverage !== null && attrCoverage < 99
                            ? ' ' + t('attr.covered') + fmtCost(attr.attributedUsd, currency, fx) + ' / '
                              + fmtCost(attr.rangeUsd, currency, fx)
                              + '(' + (attrCoverage < 1 ? '<1' : attrCoverage) + '%' + t('attr.coveredTail')
                            : '')),
                        el(Sunburst, {
                          t: t, categories: attr.categories, total: attr.attributedUsd,
                          focus: attrFocus, onFocus: setAttrFocus,
                          fmt: function (v) { return fmtCost(v, currency, fx) },
                        }),
                        el('div', { style: { marginTop: 10 } }, attr.categories.map(function (row) {
                          return el(AttributionRow, {
                            t: t, key: row.cat, row: row, total: attr.attributedUsd,
                            focus: attrFocus, onFocus: setAttrFocus,
                            fmt: function (v) { return fmtCost(v, currency, fx) },
                          })
                        })))
                    : null,

                  // Loop overhead: compaction and session-title calls are real
                  // money the user never asked for directly. Shown only when
                  // some exists, so an ordinary session sees nothing.
                  (function () {
                    var rows = (d.byPurpose || []).filter(function (r) { return r.purpose !== 'agent' && r.usd > 0 })
                    if (!rows.length) return null
                    var overhead = rows.reduce(function (sum, r) { return sum + r.usd }, 0)
                    var pct = d.totalUsd > 0 ? Math.round(overhead / d.totalUsd * 1000) / 10 : 0
                    return el('div', { style: section },
                      el('div', { style: panelT }, t('overhead.title')),
                      el('div', { style: panelSub }, t('overhead.desc') + pct + '%'),
                      rows.map(function (r) {
                        return el('div', {
                          key: r.purpose,
                          style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4, ...F.xxs },
                        },
                          el('span', { style: { color: T.label } }, purposeLabel(t, r.purpose)),
                          el('span', { style: { color: T.label3 } }, r.calls + t('heat.calls')),
                          el('span', { style: { marginLeft: 'auto', color: T.label, ...N.xxsStrong } },
                            fmtCost(r.usd, currency, fx)))
                      }))
                  })(),

                  // per-model breakdown
                  el('div', { style: section },
                    el('div', { style: panelT }, t('model.title')),
                    el('div', { style: { overflowX: 'auto', minWidth: 0 } },
                      el('table', { className: 'dshbill-table', style: { minWidth: 460 } },
                        el('thead', null, el('tr', null,
                          el('th', { style: { width: '34%' } }, t('model.col')),
                          el('th', null, t('model.calls')),
                          el('th', null, t('model.input')),
                          el('th', null, t('model.output')),
                          el('th', null, t('model.cost')))),
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
                              baseLine = (baseLine ? baseLine + ' · ' : '') + t('model.peak') + rowPeak.pct + '%'
                            }
                            // Two lines in one cell, so the row is taller than
                            // the sheet's 30px default and says so.
                            return el('tr', { key: row.provider + '/' + row.model },
                              el('td', { style: baseLine ? modelCellTall : null },
                                el('div', { style: modelIdentity },
                                  el('span', { style: modelName }, modelLabel(row)),
                                  // Outlined tag, as on the settings model rows.
                                  row.priced ? null : el('span', { style: unpricedTag }, '?'),
                                  el('span', { style: modelPct }, pct + '%')),
                                baseLine ? el('div', { style: modelBaseLine }, baseLine) : null),
                              el('td', null, String(row.calls)),
                              el('td', null, fmtTokens(row.inputTokens)),
                              el('td', null, fmtTokens(row.outputTokens)),
                              el('td', { style: N.xxsStrong }, fmtCost(row.usd, currency, fx)))
                          }))))),

                  // per-session breakdown — the unit a user actually recognises
                  (d.bySession || []).length > 1
                    ? el('div', { style: section },
                        el('div', { style: panelT }, t('session.title')),
                        (d.bySession || []).map(function (row) {
                          var top = d.bySession[0].usd || 1
                          return el('div', { key: row.sessionId, style: sessionRow },
                            el('div', { style: attrHead },
                              el('span', {
                                style: sessionName,
                                title: row.sessionId,
                              }, sessionTitle(row.sessionId) || t('session.untitled')),
                              el('span', { style: sessionCalls }, row.calls + t('session.calls')),
                              el('span', { style: attrTotal }, fmtCost(row.usd, currency, fx))),
                            el('div', { style: sessionTrack },
                              el('div', { style: { width: (row.usd / top * 100) + '%', height: '100%', background: T.business, opacity: 0.7 } })))
                        }))
                    : null,

                  // daily timeline
                  el('div', { style: section },
                    el('div', { style: panelT }, t('daily.title')),
                    d.timelineDays && d.timelineDays.length
                      ? el('div', null,
                          el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 76, paddingTop: 4, minWidth: 0, borderBottom: '1px solid ' + T.border } },
                            d.timelineDays.map(function (day) {
                              return el('div', {
                                key: day.day,
                                style: {
                                  flex: '1 1 0', minWidth: 2, maxWidth: 28, borderRadius: '4px 4px 0 0', background: T.business,
                                  height: maxDay > 0 ? Math.max(2, Math.round(day.usd / maxDay * 72)) + 'px' : '2px',
                                  opacity: 0.85,
                                },
                                title: day.day + ' · ' + fmtCost(day.usd, currency, fx) + ' · ' + day.calls + t('daily.calls'),
                              })
                            })),
                          el('div', { style: { display: 'flex', justifyContent: 'space-between', color: T.label3, marginTop: 4, ...N.xxxs } },
                            el('span', null, d.timelineDays[0] ? d.timelineDays[0].day : ''),
                            el('span', null, d.timelineDays[d.timelineDays.length - 1] ? d.timelineDays[d.timelineDays.length - 1].day : '')))
                      : el('div', { style: emptyLine }, t('daily.empty'))),

                  // heatmap
                  el('div', { style: section },
                    el('div', { style: panelT }, t('heat.title')),
                    el('div', { style: { overflowX: 'auto', minWidth: 0 } },
                      el('div', { style: { minWidth: 480 } },
                        // hour tick row
                        el('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } },
                          el('div', { style: { width: 28, flexShrink: 0 } }),
                          hourTicks.map(function (h) {
                            return el('div', {
                              key: 'tick' + h,
                              style: { flex: '1 1 0', minWidth: 0, color: T.label3, textAlign: 'left', paddingLeft: h === 0 ? 0 : 2, ...N.xxxs },
                            }, String(h))
                          })),
                        // one row per weekday
                        weekLabels.map(function (label, w) {
                          return heatmapRow(label, heatGrid[w], cellStyle, cellTitle)
                        })))),
                  // footnote
                  el('div', { style: { color: T.label3, marginTop: 12, overflowWrap: 'break-word', ...F.xxs } },
                    t('footnote'))))
    }

    /**
     * The report as a conversation view tab.
     *
     * A view entry is handed the whole centre column and owns what happens
     * inside it, including whether it scrolls — the shell provides no
     * scrollport for a tab the way the settings dialog provides one for a
     * section. So the tab supplies its own, and `Dashboard` stays a plain
     * fluid block usable in both seats.
     */
    function BillView(props) {
      // `bg-layer-1` and the scrollbar variables are what the shipped
      // Trajectory tab sets on its own root; a tab that leaves them unset shows
      // the shell's base colour and the browser's default scrollbar, which is
      // visible the moment you switch between the two.
      //
      // The composer floats OVER the view area, so a tab that does not reserve
      // room for it simply loses its last screenful — the footnote and the
      // heatmap's bottom rows were unreachable. The shell publishes the live
      // composer height as `--dsh-composer-height`; the `+ 16px` and the 152px
      // guess are Trajectory's own clearance expression, restated.
      return el('div', {
        style: {
          height: '100%', overflowY: 'auto', minWidth: 0,
          paddingBottom: 'calc(var(--dsh-composer-height, 152px) + 16px)',
          boxSizing: 'border-box',
          background: T.layer1, color: T.label,
          '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
          '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
        },
      }, el(Dashboard, props))
    }

    // ── 3. settings.section: configuration, not the report ──────────────────
    //
    // The settings slot's contract is "a feature owns its own settings pages".
    // A spend report is not a setting — it is a readout that happens to have
    // been parked in the only page-sized seat this plugin knew about. Now that
    // the report has a conversation view tab of its own, this page keeps only
    // what is genuinely configuration: the budget, and where the rest lives.
    function BillSettings(props) {
      var t = props.t || fallbackT
      var budgetPair = useBudget()
      var budget = budgetPair[0]
      var setBudget = budgetPair[1]
      // All-time totals: the budget bar needs the period figures, and nothing
      // on this page needs a range selector.
      // Same cheap action as the sidebar line: the budget bar reads one
      // period figure, not a report.
      var state = useCostApi(function () { return { action: 'periods' } }, [])
      var d = state.data
      var fx = fxOf(d)

      // No padding of its own: the settings dialog already insets its content
      // column, and every shipped section is a bare `max-width: 720px` flex
      // column inside it. The 16px this used to add put the title a step in
      // from the titles above and below it.
      return el('div', { style: { width: '100%', maxWidth: 720, boxSizing: 'border-box', minWidth: 0 } },
        el('div', { style: pageT }, t('section.title')),
        el('div', { style: { ...pageSub, whiteSpace: 'normal', marginBottom: 14 } },
          t('settings.desc')),

        budgetScope && d && d.periods
          ? el(BudgetSection, {
              t: t, budget: budget, setBudget: setBudget, currency: budget.currency, fx: fx,
              spentUsd: d.periods[budget.period] ?? 0,
            })
          : el('div', { style: { color: T.label3, ...F.s } },
              budgetScope ? t('state.loading') : t('settings.noScope')))
    }

    // ── plugin definition ───────────────────────────────────────────────────
    exports.name = 'dsh-bill'
    exports.inject = ['slots']

    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      // Dictionaries first: registering bumps the locale revision, so outlets
      // that mounted before this ran still pick the texts up. The service is
      // optional — without it every string falls back to Chinese rather than
      // rendering raw keys.
      var locale = ctx.get('locale')
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(function () {
          return locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
        }, 'dsh-bill: dictionaries')
        if (typeof locale.bind === 'function') translate = locale.bind(NS)
      }
      // Preference store for the budget. Optional: a client without the scope
      // service keeps every read-only view and simply hides the budget.
      // Probed with `ctx.get`, never `ctx.settingsScope` — the context proxy
      // throws on a bare read of an uninjected service, so the truthiness test
      // itself would abort the whole apply.
      var settingsScope = ctx.get('settingsScope')
      if (settingsScope !== undefined && typeof settingsScope.bind === 'function') {
        try { budgetScope = settingsScope.bind({ namespace: NS }) } catch (e) { budgetScope = null }
      }

      // The Connection RPC channel, if this client generation carries one.
      // Resolved once here rather than probed per request: whether the channel
      // exists is a property of the assembly, not of a call.
      var connection = ctx.get('connection')
      if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
        rpcChannel = connection.rpc
      }

      var localized = function (options) {
        if (locale !== undefined) options.locale = NS
        return options
      }

      // Cost line under the shipped stats line (current session only).
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          localized({ name: 'conversation.composer.dock', id: 'bill', order: 1 }),
          CostLine,
        )
      })

      // What each finished turn cost, under that turn. A chain entry: `select`
      // routes on the turn being closed and hands the component the turn
      // number to look up.
      slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          localized({
            name: 'conversation.chat.turnTail',
            select: function (owner) {
              var turn = owner && owner.turn
              if (!turn || turn.status !== 'closed') return null
              return { turn: turn.turn }
            },
          }),
          TurnCost,
        )
      })

      // Always-visible spend line above the settings button.
      slots.inject('sidebar.footer.action', function () {
        return slots.register(
          localized({ name: 'sidebar.footer.action', id: 'bill', order: 10 }),
          SidebarSpend,
        )
      })

      // The report, as a conversation view tab beside Chat and Trajectory.
      // This is its home: it is a readout about the work in this window, at
      // the width that work is displayed at — not a settings page, and not
      // something you leave the conversation to read. The label is a thunk so
      // the tab follows a language switch without re-registering.
      slots.inject('conversation.view', function () {
        return slots.register(
          localized({
            name: 'conversation.view',
            id: 'bill',
            order: 30,
            label: function () { return translate('view.tab') },
          }),
          BillView,
        )
      })

      // Configuration only — the budget, and a pointer to the tab above. Same
      // thunked label, which is also the string the sidebar's fallback link
      // looks the nav row up by.
      slots.inject('settings.section', function () {
        return slots.register(
          localized({
            name: 'settings.section',
            id: 'bill',
            order: 30,
            label: function () { return translate('section.title') },
          }),
          BillSettings,
        )
      })
    }

    return module.exports
  },
})
