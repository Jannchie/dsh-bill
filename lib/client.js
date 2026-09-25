/**
 * Browser half of dsh-bill.
 *
 * Six seats, chosen so each answer sits where the question is asked:
 *
 *   1. `conversation.composer.dock` — this session's cost as one pill beside
 *      the shipped stats pills (id `bill`, order 1): an icon and a figure, in
 *      the pills' own geometry; clicking opens the same kind of detail panel
 *      they do, with a way through to the full report.
 *   2. `conversation.chat.turnTail` — what each finished turn cost, under
 *      that turn. A chain entry, routed by a pure selector on the turn being
 *      closed. This is the seat that answers "which turn was expensive?",
 *      which no total can.
 *   3. `conversation.view` — this session's report, as a tab beside Chat and
 *      Trajectory (id `bill`, order 30, label "费用"). A tab over a
 *      conversation is about that conversation, so it is scoped to it.
 *   3a. `main` + `sidebar.panellist` — the account-wide report as a global
 *      panel (key/id `bill`), opened from an icon beside Plugins, the way
 *      the shell's own global pages are.
 *   4. `settings.section` — configuration only: the budget, and a pointer to
 *      the tab. A report is not a setting.
 *   5. `sidebar.footer.action` — today's spend against the budget, always
 *      visible, so overspending is noticed on the day.
 *   6. `sidebar.session.row.hover` — what a session has cost, in the hover
 *      card of its sidebar row, so it can be read without opening it.
 *      Declared from DSH 0.1.7; on older hosts the seat never appears and the
 *      entry simply never mounts.
 *
 * Everything visual is expressed in the host's design tokens: colours through
 * `--dsw-alias-*`, type through the composite `--dsw-font-*` ramp, and the
 * interactive states (hover, focus, disabled) through one injected stylesheet
 * keyed on `data-plugin-css`, which is how DSH's own plugins ship CSS. The
 * settings controls and the dock panel's placement come from the shipped
 * primitives package (Switch, Menu, useAnchoredPosition) where the host
 * serves it through the module registry; elsewhere hand-built stand-ins take
 * the same geometry.
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

    // The app's own component library, for the settings controls (Switch,
    // Menu) so they are the shipped ones rather than look-alikes. It is served
    // through the module loader's shared registry, not as a loader entry, so
    // it is required rather than injected. Optional: a host (or a test) that
    // does not expose it gets the hand-built stand-ins further down.
    var ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (e) { /* inline panel */ }
    var primitives = null
    try {
      var loaded = require('@deepseek-ai/dsh-client-ui-primitives')
      if (loaded && typeof loaded.Switch === 'function' && typeof loaded.Menu === 'function') primitives = loaded
    } catch (e) { /* stand-ins */ }

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
      base: 'var(--dsw-alias-bg-base)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
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
      /* Segmented range/period picker: one outline around the group. It sits
         beside the currency picker, so it is box-sized to the same 28px —
         without that its border lands OUTSIDE the buttons and the pair stands
         two pixels apart at the top and bottom. */
      .dshbill-seg{box-sizing:border-box;height:28px;display:inline-flex;
        border:1px solid ${T.border2};border-radius:14px;overflow:hidden;
        background:0 0}
      .dshbill-seg>button{box-sizing:border-box;height:100%;padding:0 12px;border:0;
        background:0 0;color:${T.label2};font:${F.xxs.font};cursor:pointer;
        transition:background-color ${EASE},color ${EASE}}
      .dshbill-seg>button:hover{background:${T.hover};color:${T.label}}
      .dshbill-seg>button[data-on=true]{background:${T.hover};color:${T.label};
        font:${F.xxsStrong.font}}

      /* A session's cost in its sidebar row's hover card. Copied from the
         card's own hoverStatus / hoverTime rules, literal greys included:
         the card is a dark tooltip in both themes, so a theme alias would go
         dark-on-dark in the light theme. */
      .dshbill-hover{display:flex;align-items:baseline;gap:6px;
        font:12px/20px var(--dsw-font-family);color:#adb2b8}
      .dshbill-hover>b{font-weight:500;color:#cfd3d6;font-variant-numeric:tabular-nums}

      /* This session's cost in the composer dock, as one more of the shipped
         stats pills: their font step (inherited there from the pill row, set
         here because this entry is its own dock cell), their pill geometry,
         their hover. On hosts whose dock stacks entries, the wrapper centres
         the pill the way that row centres its own. */
      .dshbill-dock{display:flex;justify-content:center;min-width:0;max-width:100%;
        box-sizing:border-box;
        font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
        line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
      .dshbill-pill{box-sizing:border-box;max-width:100%;color:${T.label3};font:inherit;
        font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;
        background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;
        padding:1px 8px;display:inline-flex;cursor:pointer;
        transition:background-color ${EASE},color ${EASE}}
      .dshbill-pill svg{flex:none;width:14px;height:14px}
      .dshbill-pill:hover{background:${T.hover};color:${T.label2}}
      .dshbill-anchor{min-width:0;display:inline-flex}
      .dshbill-pill-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
      .dshbill-pill[aria-expanded=true]{background:${T.hover};color:${T.label2}}
      /* Its detail panel: the shipped stats pills' dialog, rule for rule. */
      .dshbill-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);
        background:var(--dsw-specific-menu);width:max-content;
        min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);
        backdrop-filter:var(--dsw-menu-backdrop-filter);
        --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
        box-shadow:var(--dsw-elevation-prominent);color:${T.label2};cursor:default;
        border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
      .dshbill-panel-title{color:${T.label};justify-content:space-between;gap:16px;
        margin-bottom:8px;font-weight:500;display:flex}
      .dshbill-panel-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
      .dshbill-panel-value{font-variant-numeric:tabular-nums}
      .dshbill-panel-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
      .dshbill-panel-label svg{flex:none;width:14px;height:14px}
      .dshbill-panel-details{color:${T.label3};
        grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
      .dshbill-panel-details dt,.dshbill-panel-details dd{min-width:0;margin:0}
      .dshbill-panel-details dt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshbill-panel-details dd{color:${T.label2};font-variant-numeric:tabular-nums;text-align:right}
      /* The one action: a quiet full-width button closing the panel. */
      .dshbill-panel-action{box-sizing:border-box;width:100%;height:28px;margin-top:12px;
        border:none;border-radius:var(--dsw-radius-sm);
        background:var(--dsw-alias-bg-module-platform);color:${T.label};font:inherit;
        cursor:pointer;transition:background-color ${EASE}}
      .dshbill-panel-action:hover{background:${T.hover}}

      /* Settings rows, copied from the shipped General page's own rows
         (language, font size, developer tools): hairline between rows, 16px
         vertical rhythm, 14/22 title over a 12/18 tertiary description, one
         control on the right. */
      .dshbill-rows{display:flex;flex-direction:column;width:100%;min-width:0}
      .dshbill-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;
        gap:8px;padding:16px 0;display:flex;min-width:0}
      .dshbill-rows>.dshbill-row:last-child{border-bottom:none}
      .dshbill-row-text{flex-direction:column;flex:1;gap:4px;min-width:0;
        padding-right:48px;display:flex}
      .dshbill-row-title{color:${T.label};font-size:14px;font-weight:400;line-height:22px}
      .dshbill-row-desc{color:${T.label3};font-size:12px;font-weight:400;line-height:18px}
      .dshbill-control{align-items:center;gap:8px;display:inline-flex;flex:none}
      /* The Language row's selector pill. */
      .dshbill-selector{border-radius:var(--dsw-radius-md);
        background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;
        color:${T.label};cursor:pointer;border:none;align-items:center;gap:12px;
        padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;flex:none;
        white-space:nowrap;appearance:none;-webkit-appearance:none}
      .dshbill-selector:hover{background:${T.hover}}
      .dshbill-selector svg{flex:none}
      /* Compact, beside the report header's 28px segmented range picker. */
      .dshbill-selector[data-size=sm]{height:28px;padding:0 10px;gap:6px;
        border-radius:14px;font-size:12px;line-height:18px}
      /* The font-size stepper's field, as a typed amount. */
      .dshbill-amount{box-sizing:border-box;border-radius:var(--dsw-radius-md);
        background:var(--dsw-alias-bg-module-platform);height:36px;width:96px;border:none;
        padding:0 12px;font:inherit;font-size:14px;line-height:22px;color:${T.label};
        text-align:center;font-variant-numeric:tabular-nums;outline:none;
        -moz-appearance:textfield}
      .dshbill-amount::-webkit-inner-spin-button,
      .dshbill-amount::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
      .dshbill-amount::placeholder{color:${T.label3}}
      .dshbill-unit{color:${T.label2};font-size:14px;line-height:22px}
      .dshbill-track{height:4px;border-radius:999px;background:${T.hover};overflow:hidden;
        margin-top:4px}
      .dshbill-menu-scroll{max-height:320px;overflow-y:auto}
      /* Stand-in for the shipped Switch where the library is not served. */
      .dshbill-switch{box-sizing:border-box;flex:none;width:36px;height:20px;padding:2px;
        border:none;border-radius:999px;background:var(--dsw-alias-border-l3);
        cursor:pointer;display:inline-flex;transition:background-color ${EASE}}
      .dshbill-switch>span{width:16px;height:16px;border-radius:50%;background:#fff;
        transition:transform ${EASE}}
      .dshbill-switch[aria-checked=true]{background:${T.label}}
      .dshbill-switch[aria-checked=true]>span{transform:translateX(16px)}

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
      .dshbill-seg>button:focus-visible,.dshbill-pill:focus-visible,.dshbill-panel-action:focus-visible,
      .dshbill-selector:focus-visible,.dshbill-amount:focus-visible,
      .dshbill-switch:focus-visible,.dshbill-spend:focus-visible{box-shadow:0 0 0 2px ${T.border3};outline:none}

      @media (prefers-reduced-motion:reduce){.dshbill-seg>button,
        .dshbill-pill,.dshbill-switch,.dshbill-switch>span,.dshbill-spend,.dshbill-table tbody tr,
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
      'view.tab': '费用',
      'display.currency': '显示货币',
      'display.currency.desc': '所有费用数字用哪种货币显示。预算保留自己设定的货币。',
      'currency.other': '其他',
      'surfaces.showDock': '底栏会话费用',
      'surfaces.showDock.desc': '输入框下方的统计栏里显示本会话花了多少。',
      'surfaces.showTurnCost': '每轮成本',
      'surfaces.showTurnCost.desc': '每个结束的轮次下面一行:这轮花了多少、几步、缓存命中率。',
      'surfaces.showView': '「费用」标签页',
      'surfaces.showView.desc': '会话内与「对话」「轨迹」并列的完整报告。',
      'surfaces.showSidebar': '侧边栏今日花费',
      'surfaces.showSidebar.desc': '设置按钮上方的今日花费与预算进度。',
      'surfaces.showSessionHover': '会话悬停费用',
      'surfaces.showSessionHover.desc': '鼠标停在侧边栏会话上时,卡片里显示这个会话花了多少。',
      'turn.cost': '本轮',
      'turn.steps': ' 步',
      'turn.cache': '缓存命中 ',
      'turn.tipIn': '新增输入 ',
      'turn.tipRead': ' · 缓存读 ',
      'turn.tipWrite': ' · 缓存写 ',
      'turn.tipOut': ' · 输出 ',
      'dock.title': '本会话费用',
      'view.sessionTitle': '本会话费用',
      'dock.calls': '模型调用',
      'dock.callsUnit': ' 次',
      'dock.avg': '平均每次',
      'dock.cache': '缓存命中',
      'dock.peak': '高峰计价',
      'dock.offPeak': '低谷计价',
      'dock.open': '打开费用报告',
      'budget.amount.none': '未设置',
      'budget.periodTitle': '预算周期',
      'budget.periodDesc': '额度按哪个时间段累计。',
      'budget.currencyTitle': '预算货币',
      'budget.currencyDesc': '额度用哪种货币计;不随显示货币变动。',
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
      'budget.amount': '预算额度',
      'budget.period.day': '每日',
      'budget.period.month': '每月',
      'budget.period.all': '累计',
      'budget.used': '已用 ',
      'budget.of': ' / ',
      'budget.left': '剩余 ',
      'budget.over': '超支 ',
      'sidebar.today': '今日',
      'sidebar.open': '打开费用统计',
      'hover.cost': '费用',
      'hover.calls': ' 次调用',
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
      'view.tab': 'Cost',
      'display.currency': 'Display currency',
      'display.currency.desc': 'The currency every cost figure is shown in. The budget keeps its own.',
      'currency.other': 'Other',
      'surfaces.showDock': 'Session cost in the dock',
      'surfaces.showDock.desc': "This session's cost, in the stats row under the composer.",
      'surfaces.showTurnCost': 'Per-turn cost',
      'surfaces.showTurnCost.desc': 'A line under each finished turn: what it cost, how many steps, cache hit rate.',
      'surfaces.showView': 'Cost tab',
      'surfaces.showView.desc': 'The full report, beside Chat and Trajectory.',
      'surfaces.showSidebar': 'Sidebar spend',
      'surfaces.showSidebar.desc': "Today's spend and budget progress above the settings button.",
      'surfaces.showSessionHover': 'Session hover cost',
      'surfaces.showSessionHover.desc': 'What a session has cost, in the card shown when hovering its sidebar row.',
      'turn.cost': 'This turn',
      'turn.steps': ' steps',
      'turn.cache': 'cache hit ',
      'turn.tipIn': 'Fresh input ',
      'turn.tipRead': ' · cache read ',
      'turn.tipWrite': ' · cache write ',
      'turn.tipOut': ' · output ',
      'dock.title': "This session's cost",
      'view.sessionTitle': "This session's cost",
      'dock.calls': 'Model calls',
      'dock.callsUnit': '',
      'dock.avg': 'Average per call',
      'dock.cache': 'Cache hit',
      'dock.peak': 'At peak rate',
      'dock.offPeak': 'At off-peak rate',
      'dock.open': 'Open the cost report',
      'budget.amount.none': 'Not set',
      'budget.periodTitle': 'Budget period',
      'budget.periodDesc': 'The span the budget accumulates over.',
      'budget.currencyTitle': 'Budget currency',
      'budget.currencyDesc': 'The currency the budget is set in; it does not follow the display currency.',
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
      'budget.amount': 'Budget',
      'budget.period.day': 'Daily',
      'budget.period.month': 'Monthly',
      'budget.period.all': 'All time',
      'budget.used': 'used ',
      'budget.of': ' / ',
      'budget.left': 'left ',
      'budget.over': 'over by ',
      'sidebar.today': 'Today',
      'sidebar.open': 'Open the cost report',
      'hover.cost': 'Cost',
      'hover.calls': ' calls',
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

    /**
     * The fx table off a host payload, else the newest one seen, else the
     * two-currency stopgap. Preferring the remembered table over the stopgap
     * is what keeps a picker opened before the first answer from offering only
     * CNY and USD.
     */
    function fxOf(payload) {
      return payload && typeof payload.fx === 'object' && payload.fx !== null ? payload.fx : FX_LATEST
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
     * `ctx.layout` selects main panels (DSH 0.1.7's `selectPanel`, which the
     * global report uses) but not a session's views, the `conversation.session` inject
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
    /**
     * Preferences, over this plugin's own channel.
     *
     * NOT through `ctx.settingsScope`, which is where they started and where
     * they look like they belong. That service binds a VIEW of the harness's
     * user-settings document, and the API proxy in front of it serves a
     * hard-coded allowlist of namespaces — with the comment "a future
     * registration does not become remotely readable or writable by default".
     * A third-party namespace is permanently `unavailable` there, so the
     * client's writes were accepted and dropped and the budget had never once
     * survived a reload. Registering the namespace host-side does not help:
     * the wall is at the proxy, not at the registry.
     *
     * So the same `/dsh-bill` channel that serves the report carries the
     * preferences, and the host keeps them in its own store.
     *
     * One module-level cache with a subscriber list, rather than per-component
     * state: four components read these, and a toggle in the settings dialog
     * has to move the composer dock in the window behind it.
     */
    var SURFACES = ['showDock', 'showTurnCost', 'showView', 'showSidebar', 'showSessionHover']
    var PREFS_DEFAULT = {
      budgetAmount: 0, budgetPeriod: 'month', budgetCurrency: 'CNY', currency: 'CNY',
      showDock: true, showTurnCost: true, showView: true, showSidebar: true,
      showSessionHover: true,
    }
    var prefs = PREFS_DEFAULT
    var prefsListeners = []
    var prefsLoaded = false

    function prefsPublish(next) {
      prefs = next
      prefsListeners.slice().forEach(function (fn) { fn(prefs) })
    }
    function prefsSubscribe(fn) {
      prefsListeners.push(fn)
      // First subscriber pulls; the rest ride the same answer.
      if (!prefsLoaded) {
        prefsLoaded = true
        callBill({ action: 'prefs' })
          .then(function (d) { if (d && d.prefs) prefsPublish(d.prefs) })
          .catch(function () { /* defaults stand */ })
      }
      return function () {
        var i = prefsListeners.indexOf(fn)
        if (i >= 0) prefsListeners.splice(i, 1)
      }
    }
    /** Merge locally at once, then let the host's answer be the truth. */
    function prefsWrite(patch) {
      prefsPublish({ ...prefs, ...patch })
      callBill({ action: 'prefs-set', patch: patch })
        .then(function (d) { if (d && d.prefs) prefsPublish(d.prefs) })
        .catch(function () { /* the optimistic value stands until a reload */ })
    }

    /** Subscribe to the preferences, narrowed by `select`. */
    function usePrefs(select) {
      var state = React.useState(function () { return select(prefs) })
      var value = state[0]
      var setValue = state[1]
      React.useEffect(function () {
        setValue(select(prefs))
        return prefsSubscribe(function (next) { setValue(select(next)) })
      }, [])
      return value
    }

    function selectBudget(p) {
      return { amount: p.budgetAmount, period: p.budgetPeriod, currency: p.budgetCurrency }
    }
    function useBudget() {
      var value = usePrefs(selectBudget)
      var write = function (patch) {
        var stored = {}
        if (patch.amount !== undefined) stored.budgetAmount = patch.amount
        if (patch.period !== undefined) stored.budgetPeriod = patch.period
        if (patch.currency !== undefined) stored.budgetCurrency = patch.currency
        prefsWrite(stored)
      }
      return [value, write]
    }

    /**
     * Which surfaces this plugin is allowed to draw.
     *
     * Every seat is opt-out, not opt-in: a cost plugin that shows nothing
     * until configured is a cost plugin that gets uninstalled. An absent or
     * unreadable preference therefore means "shown".
     */
    function selectSurfaces(p) {
      var out = {}
      SURFACES.forEach(function (key) { out[key] = p[key] !== false })
      return out
    }
    function useSurfaces() {
      var value = usePrefs(selectSurfaces)
      var write = function (key, shown) {
        var patch = {}
        patch[key] = shown
        prefsWrite(patch)
      }
      return [value, write]
    }

    /**
     * The one display currency, shared by every figure the plugin prints.
     *
     * This used to be three unrelated answers: the dock line and the per-turn
     * line each hard-coded `'CNY'`, and the report tab kept its own
     * component-local `useState('CNY')` that died on reload. A reader had no
     * way to make the numbers agree, and the picker they *could* reach only
     * moved one of the three. Now all of them read this, and the report's own
     * picker writes it back — so the picker is a shortcut to the same setting,
     * not a second one.
     */
    function useDisplayCurrency() {
      var code = usePrefs(function (p) {
        return typeof p.currency === 'string' && p.currency ? p.currency : 'CNY'
      })
      var write = function (next) {
        if (typeof next === 'string' && next) prefsWrite({ currency: next })
      }
      return [code, write]
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
    // changes for the page's lifetime), so this is a branch, not a probe —
    // with one demotion. The client having a channel does not prove the host
    // mounted ours: on DSH 0.1.5 `rpc.handle` throws for every caller (it
    // resolves `webServer` through the Connection plugin's own fiber, which
    // never injects it), so the channel object exists, the route does not,
    // and every call comes back `transport failure ... HTTP 405` while the
    // POST route next door answers fine. A transport rejection — not a
    // handler error, which the host answers with `{ ok: false }` — is
    // therefore retried over HTTP, and if THAT answers, the page stays on
    // HTTP: a carrier that just worked beats one that just did not, and
    // paying a dead round-trip on every poll would only add latency.
    var rpcChannel = null
    /**
     * Newest fx table any host answer carried.
     *
     * The per-turn line has no fetch of its own — it draws from the projection
     * — so it had to guess, and its guess (`FX_FALLBACK`) covers only CNY and
     * USD. Picking EUR there printed `—`, because a missing rate converts to
     * null rather than to a number. Every host answer already carries the live
     * table, so it is remembered here instead of inventing rates.
     */
    var FX_LATEST = FX_FALLBACK
    function rememberFx(payload) {
      var rates = payload && payload.fx
      if (rates && typeof rates === 'object' && typeof rates.USD === 'number') FX_LATEST = rates
      return payload
    }
    function httpBill(payload) {
      return fetch('/dsh-bill/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json() }).then(rememberFx)
    }
    function callBill(payload) {
      if (!rpcChannel) return httpBill(payload)
      return rpcChannel.call('/dsh-bill', payload.action, payload).then(function (result) {
        if (result && result.ok) return rememberFx(result.value)
        var error = result && result.error
        throw new Error(error && error.message ? error.message : 'rpc failed')
      }, function (transportError) {
        return httpBill(payload).then(function (json) {
          rpcChannel = null
          return json
        }, function () {
          // Neither carrier answered; the RPC error names the channel and the
          // status, which is the more useful of the two to show.
          throw transportError
        })
      })
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
     * there is no second mechanism for it. An `action` that returns null
     * fetches nothing and starts no timer — a surface that is switched off,
     * or a detail nobody has asked to see yet.
     */
    function useCostApi(action, deps) {
      var state = React.useState({ loading: true, data: null, error: null })
      var data = state[0]
      var setData = state[1]
      React.useEffect(function () {
        var request = action()
        if (!request) return undefined
        var alive = true
        function load() {
          callBill(request).then(function (json) {
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

    // ── 1. composer.dock: this session's cost, as one more stats pill ───────
    //
    // The dock is the shipped stats pills' row (duration, tokens, cache hit),
    // each an outline icon and a figure. This entry is one more of them: the
    // session's cost. Clicking it opens their kind of detail panel — calls,
    // average, cache hit, the top models, the peak split — with a button
    // through to the full report, rather than jumping away from the chat.
    //
    // The figure comes from the `billTurns` projection when the host has it
    // (pushed as each turn closes, no timer), and from a `session-cost` fold
    // otherwise. The panel's detail rows need that fold too, so it runs while
    // the panel is open — and not while the pill just sits there.

    /** Dock slice: the session total, and a turn count to key the refetch on. */
    function dockSelect(value) {
      if (!value) return { usd: undefined, turns: 0 }
      return { usd: value.totalUsd, turns: value.turns ? value.turns.length : 0 }
    }
    function dockEq(a, b) { return a.usd === b.usd && a.turns === b.turns }

    /**
     * Two coins, drawn to the shipped outline set's grid: 16px box, 1px
     * `currentColor` stroke, no fill. The set has no currency glyph, and a
     * single currency sign would be wrong for every other display currency.
     */
    function CoinsIcon(props) {
      var size = (props && props.size) || 16
      return el('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1,
      },
        el('circle', { cx: 6.5, cy: 8, r: 4.5, stroke: 'currentColor' }),
        el('path', { d: 'M9.5 3.65A4.5 4.5 0 1 1 9.5 12.35', stroke: 'currentColor' }))
    }

    /**
     * Anchored panel state, as the shipped stats pills do it: the library's
     * own placement and outside-dismiss hooks where it serves them, a plain
     * above-the-anchor placement otherwise. Chosen once at module load, so the
     * hook order is the same on every render.
     */
    var PANEL_GAP = 8
    var PANEL_MARGIN = 12
    var MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    var anchoredHooks = !!(primitives
      && typeof primitives.useAnchoredPosition === 'function'
      && typeof primitives.useDismissOnOutsidePointer === 'function')
    function useStatPanel() {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var rootRef = React.useRef(null)
      var panelRef = React.useRef(null)
      var pos
      if (anchoredHooks) {
        pos = primitives.useAnchoredPosition({
          open: open, anchorRef: rootRef, panelRef: panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN,
        })
        primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
      } else {
        var placed = React.useState(null)
        pos = placed[0]
        var setPos = placed[1]
        React.useLayoutEffect(function () {
          if (!open || !rootRef.current || typeof window === 'undefined') { setPos(null); return }
          var r = rootRef.current.getBoundingClientRect()
          setPos({ left: Math.max(PANEL_MARGIN, r.left), bottom: window.innerHeight - r.top + PANEL_GAP })
        }, [open])
        React.useEffect(function () {
          if (!open) return
          var onDown = function (e) {
            var inRoot = rootRef.current && rootRef.current.contains(e.target)
            var inPanel = panelRef.current && panelRef.current.contains(e.target)
            if (!inRoot && !inPanel) setOpen(false)
          }
          document.addEventListener('pointerdown', onDown)
          return function () { document.removeEventListener('pointerdown', onDown) }
        }, [open])
      }
      React.useEffect(function () {
        if (!open) return
        var onKey = function (e) { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [open])
      return { open: open, setOpen: setOpen, rootRef: rootRef, panelRef: panelRef, pos: pos }
    }

    /** Portal to the body, like the shipped panels, where react-dom is served. */
    function portal(node) {
      if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
        return ReactDOM.createPortal(node, document.body)
      }
      return node
    }

    function CostLine(props) {
      var t = props.t || fallbackT
      var shown = useSurfaces()[0].showDock
      var sessionId = props.sessionId || (props.session && props.session.sessionId)
      // Hooks above the early returns, so the order never depends on data.
      var currency = useDisplayCurrency()[0]
      var session = useBillTurns(props, dockSelect, dockEq)
      var panel = useStatPanel()
      // The fold is only needed for what the projection does not carry: the
      // panel's detail rows, or the figure itself on a host without the
      // projection. A closed pill on a current host fetches nothing.
      var wanted = shown && sessionId && (panel.open || session.usd === undefined)
      var state = useCostApi(function () {
        return wanted ? { action: 'session-cost', sessionId: sessionId } : null
      }, [sessionId, session.turns, wanted])
      if (!shown || !sessionId) return null
      var d = state.data && !state.data.error ? state.data : null
      var fx = fxOf(d)
      var usd = session.usd !== undefined ? session.usd : (d ? d.totalUsd : undefined)
      // Nothing spent yet reads as nothing to say, like the shipped pills.
      if (!(usd > 0)) return null
      var fmt = function (v) { return fmtCost(v, currency, fx) }
      var figure = fmt(usd)

      var rows = []
      if (panel.open && d && d.calls > 0) {
        rows.push([t('dock.calls'), fmtInt(d.calls) + t('dock.callsUnit')])
        rows.push([t('dock.avg'), fmt(usd / d.calls)])
        var hit = cacheHitPct(d.cacheReadTokens, d.uncachedInputTokens, d.cacheWriteTokens)
        if (hit !== null) rows.push([t('dock.cache'), hit + '%'])
        ;(d.byModel || []).slice(0, 3).forEach(function (row) {
          if (row.usd > 0) rows.push([modelLabel(row), fmt(row.usd)])
        })
        var peak = peakShare(d)
        if (peak) {
          rows.push([t('dock.peak'), fmt(peak.peakUsd)])
          rows.push([t('dock.offPeak'), fmt(peak.offPeakUsd)])
        }
      }

      return el('div', { className: 'dshbill-dock' },
        el('span', { ref: panel.rootRef, className: 'dshbill-anchor' },
          el('button', {
            type: 'button',
            className: 'dshbill-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': panel.open,
            'aria-label': t('dock.title') + ' ' + figure,
            onClick: function () { panel.setOpen(!panel.open) },
          }, el(CoinsIcon), el('span', { className: 'dshbill-pill-label' }, figure)),
          panel.open
            ? portal(el('div', {
                ref: panel.panelRef,
                className: 'dshbill-panel',
                role: 'dialog',
                'aria-label': t('dock.title'),
                style: panel.pos || MEASURE_STYLE,
              },
                el('div', { className: 'dshbill-panel-title' },
                  el('span', { className: 'dshbill-panel-label' }, el(CoinsIcon), t('dock.title')),
                  el('span', { className: 'dshbill-panel-value' }, figure)),
                rows.length
                  ? el('div', { className: 'dshbill-panel-rule', 'aria-hidden': true })
                  : null,
                rows.length
                  ? el('dl', { className: 'dshbill-panel-details' }, rows.map(function (row, i) {
                      return [
                        el('dt', { key: 'k' + i, title: row[0] }, row[0]),
                        el('dd', { key: 'v' + i }, row[1]),
                      ]
                    }))
                  : null,
                el('button', {
                  type: 'button',
                  className: 'dshbill-panel-action',
                  onClick: function () {
                    panel.setOpen(false)
                    openBillView(translate('view.tab'))
                  },
                }, t('dock.open'))))
            : null))
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
    /** Separator tone taken from the shipped stats row's `.sep`. */
    var costSep = { color: T.sep }
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

    /** The closed turn's number from turnTail owner props, or null. */
    function turnOf(owner) {
      var turn = owner && owner.turn
      if (!turn || turn.status !== 'closed') return null
      return turn.turn
    }

    function TurnCost(props) {
      var t = props.t || fallbackT
      // Above the early returns: a turn that renders nothing must still call
      // the same hooks as one that does.
      var currency = useDisplayCurrency()[0]
      var shown = useSurfaces()[0].showTurnCost
      // A chain entry (DSH 0.1.5) gets the turn number from its selector as
      // `matched`; a list entry (0.1.7+) gets the owner's `turn` directly.
      var wanted = props.matched ? props.matched.turn : turnOf(props)
      // Narrowed to this turn's own row, so a usage report for ANOTHER turn
      // does not re-render this one. The equality test is row identity, which
      // is exactly the granularity `apply` preserves.
      var row = useBillTurns(
        props,
        React.useCallback(function (value) { return turnRowOf(value, wanted) }, [wanted]),
      )
      if (!shown) return null
      // No row means the turn aged out of the capped list, or it made no model
      // call at all (a rejected or empty turn). Both are "nothing to say".
      if (!row || row.usd === null || !(row.usd > 0)) return null

      var fx = FX_LATEST
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
      // Above the early returns, so the hook order does not depend on whether
      // this line has anything to draw.
      var currency = useDisplayCurrency()[0]
      // `periods` rather than `dashboard`: this line needs day/month/all-time
      // and nothing else, and asking for the report built a timeline, heatmap,
      // attribution tree and forecast over the whole ring to be thrown away.
      var state = useCostApi(function () { return { action: 'periods' } }, [])
      var budgetPair = useBudget()
      var budget = budgetPair[0]
      var shown = useSurfaces()[0].showSidebar
      var d = state.data
      if (!shown) return null
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
        // Today's spend is an account-wide figure, so it opens the global
        // panel. The session tab would be the wrong answer; where the host has
        // no panel seat, the settings page (budget) is the fallback.
        onClick: function () {
          openBillPanel() || openSettingsSection(translate('section.title'))
        },
        style: { color: color, ...F.xs },
      },
        wide ? el('span', { style: { color: T.label3, flexShrink: 0 } }, t('sidebar.today')) : null,
        wide
          ? el('span', { style: N.xsStrong },
              // Against a budget the figure stays in the budget's currency, so
              // the amount and the percentage below it cannot disagree. With
              // no budget there is nothing to agree with, so it follows the
              // display currency like every other bare cost.
              fmtCost(todayUsd, budget.amount > 0 ? budget.currency : currency, fx))
          : null,
        pct !== null
          ? el('span', {
              style: { marginLeft: wide ? 'auto' : 0, flexShrink: 0, ...N.xxs },
            }, Math.round(pct) + '%')
          : null)
    }

    // ── 1c. session row hover card: what this session cost ───────────────────
    //
    // The report answers "which session was expensive?" only once you go and
    // look. The sidebar already opens a card per session on hover; one line
    // there answers it for the session you are pointing at, before you open it.
    //
    // `session-cost` folds only this session's records, and the seat mounts
    // the entry only while the card is open, so this is one small call per
    // hover — never one per row.
    //
    // Geometry and colours live in `.dshbill-hover`, copied from the card's
    // own rules — see the sheet for why they are literal greys.

    function SessionHoverCost(props) {
      var t = props.t || fallbackT
      var sessionId = props.sessionId
      // Above the early returns, like every other seat here.
      var currency = useDisplayCurrency()[0]
      var shown = useSurfaces()[0].showSessionHover
      var state = useCostApi(function () {
        return shown && sessionId ? { action: 'session-cost', sessionId: sessionId } : null
      }, [sessionId, shown])
      if (!shown || !sessionId) return null
      var d = state.data
      // A session this plugin never saw, or one with no priced call, has
      // nothing to say: "¥0.00" would read as "this session was free".
      if (!d || d.error || !(d.totalUsd > 0)) return null
      var items = [
        el('span', { key: 'l' }, t('hover.cost')),
        el('b', { key: 'v' }, fmtCost(d.totalUsd, currency, fxOf(d))),
      ]
      if (d.calls > 0) {
        items.push(el('span', { key: 's' }, '·'))
        items.push(el('span', { key: 'c' }, fmtInt(d.calls) + t('hover.calls')))
      }
      return el('div', { className: 'dshbill-hover' }, items)
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
    // Outline only, no fill — the shipped settings cards are the same. A fill
    // would have to name a colour relative to a ground this component does not
    // set, and naming the wrong one is exactly what made the tab flash a
    // different colour from Chat.
    var card = {
      border: '1px solid ' + T.border2, borderRadius: 12, padding: '12px 14px',
      boxSizing: 'border-box', minWidth: 0,
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

    // ── settings controls: the shipped ones, or stand-ins ───────────────────

    /** One settings row: title and description left, one control right. */
    function SettingRow(props) {
      return el('div', { className: 'dshbill-row' },
        el('div', { className: 'dshbill-row-text' },
          el('div', { className: 'dshbill-row-title' }, props.title),
          props.desc ? el('div', { className: 'dshbill-row-desc' }, props.desc) : null,
          props.extra || null),
        props.control)
    }

    /** The shipped Switch; a same-sized button where it is not served. */
    function Toggle(props) {
      if (primitives) {
        return el(primitives.Switch, { checked: props.checked, label: props.label, onChange: props.onChange })
      }
      return el('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'dshbill-switch',
        onClick: function () { props.onChange(!props.checked) },
      }, el('span'))
    }

    function Chevron() {
      if (primitives && typeof primitives.IconChevronDownOutlineRegular === 'function') {
        return el(primitives.IconChevronDownOutlineRegular)
      }
      return el('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
        el('path', { d: 'M4 6L8 10L12 6', stroke: 'currentColor' }))
    }

    /**
     * One-of-N picker, as the Language row does it: a selector pill opening
     * the shipped Menu, aligned to its end. `items` are Menu entries
     * (`{ id, label }`, or an item with a `submenu`); the stand-in flattens
     * them into a native select in the same pill.
     */
    function Choice(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      if (primitives) {
        return el(primitives.Menu, {
          open: open,
          onClose: function () { setOpen(false) },
          items: props.items,
          selectedId: props.value,
          onSelect: function (id) { props.onSelect(id); setOpen(false) },
          align: 'end',
          portal: true,
          listClassName: 'dshbill-menu-scroll',
          anchor: el('button', {
            type: 'button',
            className: 'dshbill-selector',
            'data-size': props.size,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': props.label,
            onClick: function () { setOpen(!open) },
          }, props.display, el(Chevron)),
        })
      }
      var flat = []
      ;(function walk(list) {
        list.forEach(function (item) {
          if (item.submenu) walk(item.submenu)
          else if (item.id && item.type === undefined) flat.push(item)
        })
      })(props.items)
      return el('select', {
        className: 'dshbill-selector',
        'data-size': props.size,
        value: props.value,
        'aria-label': props.label,
        onChange: function (e) { props.onSelect(e.target.value) },
      }, flat.map(function (item) { return el('option', { key: item.id, value: item.id }, item.label) }))
    }

    /** "¥ CNY" — the symbol where one is known, then the code. */
    function currencyLabel(code) {
      return (CURRENCY_SYMBOL[code] ? CURRENCY_SYMBOL[code] + ' ' : '') + code
    }

    /**
     * Menu entries for a currency picker: the pinned dozen first, the rest of
     * the live fx table (~170) folded into one submenu so the menu stays one
     * screen tall.
     */
    var otherCurrencies = new WeakMap()
    function currencyItems(t, fx, value) {
      var common = []
      var seen = {}
      CURRENCIES.forEach(function (code) {
        if (!fx || fx[code] !== undefined || code === value) {
          seen[code] = true
          common.push({ id: code, label: currencyLabel(code) })
        }
      })
      // The tail depends only on the fx table, which is replaced rather than
      // mutated, so it is sorted once per table instead of once per render.
      var other = fx ? otherCurrencies.get(fx) : []
      if (!other) {
        other = Object.keys(fx).sort().filter(function (code) { return CURRENCIES.indexOf(code) < 0 })
          .map(function (code) { return { id: code, label: currencyLabel(code) } })
        otherCurrencies.set(fx, other)
      }
      other = other.filter(function (item) { return !seen[item.id] })
      if (value && !seen[value] && !(fx && fx[value] !== undefined)) common.push({ id: value, label: currencyLabel(value) })
      if (other.length === 0) return common
      return common.concat([{ id: '__other', label: t('currency.other'), submenu: other }])
    }

    /**
     * Budget: the amount and how it is doing, then — as rows of their own —
     * the period and the currency it is counted in.
     *
     * The limit is stored in the currency it was set in, not converted at write
     * time — "¥100 a month" must stay ¥100 when the display currency changes,
     * and a stored USD equivalent would drift with the exchange rate.
     */
    function BudgetRows(props) {
      var t = props.t
      var budget = props.budget
      var setBudget = props.setBudget
      var fx = props.fx
      // Typed text is kept locally so "" and "1." survive a keystroke; the
      // stored number follows it.
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]

      var sym = symbol(budget.currency).trim()
      var b = budget.amount > 0 && props.spentUsd !== undefined ? budgetState(t, budget, props.spentUsd, fx) : null
      var status = !(budget.amount > 0) ? t('budget.desc')
        : !b ? t('state.loading')
          : el('span', { style: { color: b.level === 'ok' ? undefined : b.color } },
              t('budget.period.' + budget.period) + ' · ' + b.usedText + ' · ' + b.remainingText)

      return [
        el(SettingRow, {
          key: 'amount',
          title: t('budget.amount'),
          desc: status,
          extra: b ? el(BudgetBar, { state: b }) : null,
          control: el('div', { className: 'dshbill-control' },
            el('input', {
              type: 'number', min: 0, step: 1, inputMode: 'decimal',
              className: 'dshbill-amount',
              placeholder: t('budget.amount.none'),
              'aria-label': t('budget.amount'),
              value: draft !== null ? draft : (budget.amount > 0 ? String(budget.amount) : ''),
              onChange: function (e) {
                setDraft(e.target.value)
                var n = Number(e.target.value)
                setBudget({ amount: Number.isFinite(n) && n > 0 ? n : 0 })
              },
              onBlur: function () { setDraft(null) },
            }),
            el('span', { className: 'dshbill-unit' }, sym)),
        }),
        el(SettingRow, {
          key: 'period',
          title: t('budget.periodTitle'),
          desc: t('budget.periodDesc'),
          control: el(Choice, {
            label: t('budget.periodTitle'),
            value: budget.period,
            display: t('budget.period.' + budget.period),
            items: ['day', 'month', 'all'].map(function (p) { return { id: p, label: t('budget.period.' + p) } }),
            onSelect: function (p) { setBudget({ period: p }) },
          }),
        }),
        el(SettingRow, {
          key: 'currency',
          title: t('budget.currencyTitle'),
          desc: t('budget.currencyDesc'),
          control: el(Choice, {
            label: t('budget.currencyTitle'),
            value: budget.currency,
            display: currencyLabel(budget.currency),
            items: currencyItems(t, fx, budget.currency),
            onSelect: function (code) { setBudget({ currency: code }) },
          }),
        }),
      ]
    }

    /**
     * The report's budget card: how much of the limit is gone, read-only.
     * Setting the budget is configuration, so it lives on the settings page;
     * with no budget set this card is simply absent.
     */
    function BudgetStatus(props) {
      var t = props.t
      var budget = props.budget
      if (!(budget.amount > 0)) return null
      var b = budgetState(t, budget, props.spentUsd, props.fx)
      return el('div', { style: section },
        el('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          el('div', { style: { ...panelT, marginBottom: 0 } }, t('budget.title')),
          el('span', { style: { color: T.label3, ...F.xxs } }, t('budget.period.' + budget.period)),
          el('span', {
            style: { marginLeft: 'auto', color: b.level === 'over' ? T.error : T.label, ...N.xxsStrong },
          }, b.usedText)),
        el(BudgetBar, { state: b, height: 6, marginTop: 8 }),
        el('div', { style: { color: T.label3, marginTop: 4, ...N.xxs } },
          b.pct === null ? '—' : b.remainingText + ' · ' + Math.round(b.pct) + '%'))
    }

    /**
     * How a budget is doing, computed once for every surface that shows it:
     * spend in the budget's own currency, the share used, the level (amber
     * from 80%, red over 100%), its colour, and the two sentences.
     */
    function budgetState(t, budget, spentUsd, fx) {
      var sym = symbol(budget.currency)
      var spent = convert(spentUsd, budget.currency, fx)
      var pct = spent === null ? null : spent / budget.amount * 100
      var level = pct === null ? 'ok' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
      var remaining = spent === null ? null : budget.amount - spent
      return {
        pct: pct,
        level: level,
        color: level === 'over' ? T.error : level === 'warn' ? T.warn : T.business,
        usedText: t('budget.used') + sym + (spent === null ? '—' : spent.toFixed(2))
          + t('budget.of') + sym + budget.amount.toFixed(2),
        remainingText: remaining === null ? '—'
          : remaining >= 0 ? t('budget.left') + sym + remaining.toFixed(2)
            : t('budget.over') + sym + (-remaining).toFixed(2),
      }
    }

    /** The budget's progress track, filled to its share in its level's colour. */
    function BudgetBar(props) {
      var s = props.state
      return el('div', {
        className: 'dshbill-track',
        style: props.height ? { height: props.height, marginTop: props.marginTop } : undefined,
      },
        el('div', {
          style: {
            width: Math.min(100, s.pct === null ? 0 : s.pct) + '%', height: '100%',
            background: s.color, transition: 'width .2s ' + T.ease,
          },
        }))
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


    /** Widest a single day's bar may grow to, and the gap between two. */
    var BAR_MAX = 28
    var BAR_GAP = 3
    var timelineRow = {
      display: 'flex', alignItems: 'flex-end', gap: BAR_GAP, height: 76,
      paddingTop: 4, minWidth: 0, borderBottom: '1px solid ' + T.border,
    }
    var timelineAxis = { display: 'flex', justifyContent: 'space-between', color: T.label3, marginTop: 4, ...N.xxxs }
    /** How wide `count` bars can get before they stop growing. */
    function timelineWidth(count) {
      return count * BAR_MAX + Math.max(0, count - 1) * BAR_GAP
    }
    /** `2026-08-15` → `08-15`. Anything unexpected passes through. */
    function monthDay(day) {
      return typeof day === 'string' && day.length === 10 ? day.slice(5) : day || ''
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
      // The conversation tab passes its session; the global panel does not.
      var sessionScope = props.scope === 'session' && props.sessionId ? props.sessionId : null
      // Titles live in the shell's session list; our records only carry ids.
      // Only the account-wide per-session split reads them, so a session
      // report subscribes to nothing and does not re-render on list changes.
      var sessions = typeof props.useSessions === 'function'
        ? props.useSessions(function (state) { return sessionScope ? null : state && state.byId })
        : null
      var sessionTitle = function (id) {
        var entry = sessions && sessions[id]
        return entry && typeof entry.title === 'string' ? entry.title : ''
      }
      // A session is short and wholly in view, so its tab opens on all of it.
      var range = React.useState(sessionScope ? 0 : 30)
      var rangeDays = range[0]
      var setRange = range[1]
      // Same preference the settings page and the other surfaces read, so the
      // picker here is a shortcut to it rather than a fourth place currency
      // could disagree from.
      var cur = useDisplayCurrency()
      var currency = cur[0]
      var setCurrency = cur[1]
      var budgetPair = useBudget()
      var budget = budgetPair[0]
      // Which category the sunburst is drilled into (null = the whole bill).
      var focusState = React.useState(null)
      var attrFocus = focusState[0]
      var setAttrFocus = focusState[1]

      var state = useCostApi(function () {
        return { action: 'dashboard', rangeDays: rangeDays, sessionId: sessionScope || undefined }
      }, [rangeDays, sessionScope])
      // Balance is a separate, slower call (it hits the provider), so it is
      // fetched on its own and simply absent until it lands. It is an account
      // fact, so a session report never asks for it.
      var balanceState = useCostApi(function () {
        return sessionScope ? null : { action: 'balance' }
      }, [sessionScope])
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
            hint: sessionScope ? '' : (rangeDays > 0 ? rangeDays + t('kpi.totalHint') : '')
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
      //
      // Mixed toward `transparent`, not toward a named surface: that yields an
      // alpha the cell composites over whatever ground it is actually on, so
      // the scale stays correct without this file naming the ground at all.
      function cellStyle(cell) {
        if (cell.usd <= 0 || maxCell <= 0) return { background: T.hover }
        var pct = (15 + 80 * (cell.usd / maxCell)).toFixed(0)
        return {
          background: 'color-mix(in srgb, var(--dsw-static-blue-450, rgb(77,147,248)) '
            + pct + '%, transparent)',
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
          el('div', { style: pageT }, t(sessionScope ? 'view.sessionTitle' : 'section.title')),
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
            el(Choice, {
              size: 'sm',
              label: t('display.currency'),
              value: currency,
              display: currencyLabel(currency),
              items: currencyItems(t, d && d.fx, currency),
              onSelect: setCurrency,
            }))),

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

                  // budget
                  d.periods
                    ? el(BudgetStatus, {
                        t: t, budget: budget, fx: fx,
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
                      // Bars are capped at 28px, so a short range does not fill
                      // the row — and the axis, spanning the full width, then
                      // flung its end date far past the last bar. Both rows are
                      // bounded to the width the bars actually occupy, so the
                      // dates land on the ends of the chart rather than the
                      // ends of the page.
                      ? el('div', { style: { maxWidth: timelineWidth(d.timelineDays.length), minWidth: 0 } },
                          el('div', { style: timelineRow },
                            d.timelineDays.map(function (day) {
                              return el('div', {
                                key: day.day,
                                style: {
                                  flex: '1 1 0', minWidth: 2, maxWidth: BAR_MAX, borderRadius: '4px 4px 0 0', background: T.business,
                                  height: maxDay > 0 ? Math.max(2, Math.round(day.usd / maxDay * 72)) + 'px' : '2px',
                                  opacity: 0.85,
                                },
                                title: day.day + ' · ' + fmtCost(day.usd, currency, fx) + ' · ' + day.calls + t('daily.calls'),
                              })
                            })),
                          // Month-day only: the year is the same on every tick
                          // of a range the picker above already names, and the
                          // full date is on each bar's own tooltip.
                          el('div', { style: timelineAxis },
                            el('span', null, monthDay(d.timelineDays[0].day)),
                            d.timelineDays.length > 1
                              ? el('span', null, monthDay(d.timelineDays[d.timelineDays.length - 1].day))
                              : null))
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
      // No background, no colour, no scrollbar variables: Chat's own root sets
      // none of them either, so inheriting is what puts this tab on the same
      // ground as the tab beside it. Trajectory does lift itself to
      // `bg-layer-1`, but that is a dense table pane earning a surface of its
      // own — copying it here just made switching tabs flash a different
      // colour, which is the opposite of the point.
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
        },
      }, el(Dashboard, { ...props, scope: 'session' }))
    }

    /**
     * The account-wide report, as a global main panel beside Plugins. The
     * panel is handed the main column and nothing else, so like the tab it
     * supplies its own scrollport.
     */
    function BillPanel(props) {
      return el('div', {
        style: { height: '100%', overflowY: 'auto', minWidth: 0, boxSizing: 'border-box' },
      }, el(Dashboard, { ...props, scope: 'global' }))
    }

    /** Its sidebar icon: the coins, at the size and state the row asks for. */
    function BillPanelIcon(props) {
      return el(CoinsIcon, { size: props.size || 18 })
    }

    /**
     * Open the global panel through the layout service. Resolved at click
     * time, not at apply time: `layout` is not injected, so it may arrive
     * after this plugin did.
     */
    var appCtx = null
    function openBillPanel() {
      var layout = appCtx && appCtx.get('layout')
      if (!layout || typeof layout.selectPanel !== 'function') return false
      try { layout.selectPanel('bill'); return true } catch (e) { return false }
    }

    // ── 3. settings.section: configuration, not the report ──────────────────
    //
    // A spend report is not a setting, so this page keeps only what is
    // configuration — budget, display currency, one switch per surface — as a
    // flat list of the shipped General page's rows: no page title (the
    // dialog's nav already names it) and no section cards.
    function BillSettings(props) {
      var t = props.t || fallbackT
      var budgetPair = useBudget()
      var budget = budgetPair[0]
      var currencyPair = useDisplayCurrency()
      var surfacesPair = useSurfaces()
      var surfaces = surfacesPair[0]
      // Same cheap action as the sidebar line: the budget reads one period
      // figure, not a report.
      var state = useCostApi(function () { return { action: 'periods' } }, [])
      var d = state.data
      var fx = fxOf(d)
      var spentUsd = d && d.periods ? (d.periods[budget.period] ?? 0) : undefined

      return el('div', { className: 'dshbill-rows' },
        el(BudgetRows, { t: t, budget: budget, setBudget: budgetPair[1], fx: fx, spentUsd: spentUsd }),
        el(SettingRow, {
          title: t('display.currency'),
          desc: t('display.currency.desc'),
          control: el(Choice, {
            label: t('display.currency'),
            value: currencyPair[0],
            display: currencyLabel(currencyPair[0]),
            items: currencyItems(t, d && d.fx, currencyPair[0]),
            onSelect: currencyPair[1],
          }),
        }),
        SURFACES.map(function (key) {
          return el(SettingRow, {
            key: key,
            title: t('surfaces.' + key),
            desc: t('surfaces.' + key + '.desc'),
            control: el(Toggle, {
              checked: surfaces[key],
              label: t('surfaces.' + key),
              onChange: function (next) { surfacesPair[1](key, next) },
            }),
          })
        }))
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

      // What each finished turn cost, under that turn. The seat changed kind:
      // DSH 0.1.5 declares it a CHAIN (a pure `select` routes on the turn
      // being closed), 0.1.7 a LIST (a required `id`, every entry mounted,
      // and `select` rejected). Registering the wrong shape throws, and the
      // throw takes every plugin in the same client bundle down with it, so
      // the shape follows the declared spec rather than a host version guess.
      slots.inject('conversation.chat.turnTail', function () {
        var spec = typeof slots.spec === 'function' ? slots.spec('conversation.chat.turnTail') : undefined
        if (spec && spec.kind === 'list') {
          return slots.register(
            localized({ name: 'conversation.chat.turnTail', id: 'bill', order: 50 }),
            TurnCost,
          )
        }
        return slots.register(
          localized({
            name: 'conversation.chat.turnTail',
            select: function (owner) {
              var turn = turnOf(owner)
              return turn === null ? null : { turn: turn }
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

      // What a session cost, in its sidebar row's hover card (DSH >= 0.1.7).
      slots.inject('sidebar.session.row.hover', function () {
        return slots.register(
          localized({ name: 'sidebar.session.row.hover', id: 'bill', order: 10 }),
          SessionHoverCost,
        )
      })

      // The account-wide report: a global main panel, and its icon in the
      // sidebar's panel row beside Plugins. Both seats are declared by the
      // shell from DSH 0.1.7; on hosts without them these never mount.
      appCtx = ctx
      slots.inject('main', function () {
        return slots.register(localized({ name: 'main', key: 'bill' }), BillPanel)
      })
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          localized({
            name: 'sidebar.panellist',
            id: 'bill',
            order: 5,
            label: function () { return translate('section.title') },
          }),
          BillPanelIcon,
        )
      })

      // The report, as a conversation view tab beside Chat and Trajectory.
      // This is its home: it is a readout about the work in this window, at
      // the width that work is displayed at — not a settings page, and not
      // something you leave the conversation to read. The label is a thunk so
      // the tab follows a language switch without re-registering.
      //
      // The only seat that cannot be hidden by rendering nothing: a view entry
      // owns a TAB, and an entry whose component returns null still leaves an
      // empty tab in the strip. So this one is registered and unregistered as
      // the preference changes, rather than gated inside the component.
      slots.inject('conversation.view', function () {
        var options = localized({
          name: 'conversation.view',
          id: 'bill',
          order: 30,
          label: function () { return translate('view.tab') },
        })
        var stop = null
        var sync = function (p) {
          var shown = p.showView !== false
          if (shown && !stop) stop = slots.register(options, BillView)
          else if (!shown && stop) { stop(); stop = null }
        }
        var unsubscribe = prefsSubscribe(sync)
        sync(prefs)
        return function () {
          unsubscribe()
          if (stop) stop()
        }
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
