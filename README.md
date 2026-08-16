# dsh-bill

English | [中文](README.zh.md)

Cost tracking for DSH (DeepSeek Harness). A line under each turn tells you what that turn cost; the **Cost** tab tells you what the money went on.

![Per-turn cost in the conversation](docs/in-chat.png)

![Cost attribution](docs/attribution.png)

## Install

```bash
dsh plugin --profile web add dsh-bill
```

Restart `dsh web` to pick it up.

## Features

- **Cost attribution** — the bill split by kind of content: tool output, model output, system prompt, terminal commands (grouped by `git` / `pnpm` / `rg`), tool input, attachments, system reminders, user input. The sunburst drills in.
- **Per-turn cost** — one line under every finished turn: what it cost, how many steps, the cache-hit rate. It reads the session log itself, so turns from before you installed the plugin are covered too.
- **Always on screen** — a line under the shipped stats line (all-time, this session, peak share), and today's spend against the budget in the sidebar.
- **Report** — a **Cost** tab in the conversation, beside Chat and Trajectory: total, tokens, cache hit, peak share, monthly forecast, account balance; broken down by model, by session, and by purpose (including loop overhead such as context compaction); a daily trend and a weekday × hour heatmap.
- **Budget** — a daily / monthly / all-time limit that turns amber past 80% and red when you go over.
- **Multi-currency** — live rates for ~166 currencies; each model's base rate is shown in the currency its vendor prices it in.
- **Agent tool** — `bill_stats`, so the model can answer questions about spend directly.
- English and Chinese follow the DSH language setting; history from before the install is backfilled from the session log.

## How it differs from similar plugins

Three substantive differences:

**No hand-maintained price table.** Every other plugin ships a built-in table of 2–4 DeepSeek models, which means no prices at all once you switch provider — and which is why they all need a "edit the price table by hand" entry point. dsh-bill pulls models.dev and OpenRouter through [`llm-pricing`](https://github.com/Jannchie/llm-pricing), covering 8000+ entries, so a new model is priced the day it ships.

**Price is a timeline, not a number.** The others compute a cost and store it (or recompute at today's price), so history goes wrong the moment a vendor changes its rates or a call crosses a peak/off-peak boundary. dsh-bill prices each call at that call's own instant, and never recomputes history.

**It answers "on what".** The others answer only "how much" — they consume the provider's aggregate token counts and never look at the request content. dsh-bill splits the request into classified segments at capture time and apportions cost by position in the cache prefix.

They do some things better: `usage-stats` reads balances and subscription quotas from 11 providers (dsh-bill only does DeepSeek), `cost-meter` can read OpenCode Go's subscription quota, and both surface more always-on entry points than dsh-bill does.

<details>
<summary>Point-by-point comparison (read from source, sampled 2026-08-16)</summary>

The sample is the cost-related plugins under the GitHub `dsh-plugin` topic with ★ ≥ 40, plus the four published to npm. Lower-starred plugins such as `deepseek-harness-wallet` were not checked individually.

| | dsh-bill | cost-meter | usage-stats | dsh-cost | cost-log | dsh-usage | usage-billing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| stars / version | — | ★42 / 1.3.1 | ★40 / 0.2.0 | ★3 / 0.2.1 | ★2 / 1.0.0 | ★2 / 0.1.1 | 0.2.2 |
| price source | online catalogue | built-in table + hand-scraped docs | none | built-in table | built-in table | user-entered | built-in table |
| models covered | 8000+ entries | 4 DeepSeek | — | 4 DeepSeek | 2 DeepSeek | one at a time, by hand | DeepSeek |
| unlisted model | flagged, excluded from totals | billed at flash rate | flagged unknown | billed as v4-pro | flagged `≈` | flagged `--` | counted as 0 |
| history never recomputed | ✓ | ✗ | — | ✗ | ✓ | ✓ | manual backfill |
| content attribution | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| forecast | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| budget | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| account balance | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| pre-install history | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ |
| agent tool | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| currencies | 166, live rates | 3, fixed rates | — | follows UI language | ¥/$ | single | ¥ only |

</details>

## Pricing

- two catalogues, models.dev and OpenRouter, cached for 24h and written to disk, falling back to a built-in historical snapshot on failure;
- DeepSeek's own direct rates override the catalogue, and the peak / off-peak rate is chosen from the call's timestamp;
- model names are normalised, and anything that still fails to match is flagged `?` and excluded from totals — nothing is estimated;
- `priceOverrides` can override or add any price (rarely needed).

## Attribution method

Every request pays for the full context again, so one tool output read into the conversation keeps being billed on every subsequent request until it slides out of the window. Attribution is computed per request and summed.

Two things matter:

- **Price by position.** Under prefix caching the first N tokens of the prompt bill at the cache rate and the rest at full rate — on DeepSeek the two differ by up to 156×. Segments are ordered exactly as the provider received them, the cached prefix is charged at the cache rate, and only the tail pays full price. Apportioning by an average unit price files the money under the wrong category.
- **Counts only.** Attribution happens at capture time on the live request; only the per-category amounts are written to disk. No prompt text is stored.

Per-segment token counts are estimated from character share (providers return only a total), and the total is the real billed figure, so the parts sum exactly to what you paid.

The session log holds token counts and model routes but **not the request bodies** — which is why pre-install history can be backfilled as spend, but **cannot be attributed retroactively**. The report states what fraction is covered.

## Configuration

The budget is set on the **Cost** page in settings. `maxRecords` (the in-memory ring buffer size, default 20000) and `priceOverrides` are plugin config and are validated at startup — a mistyped field is reported by name rather than leaving the report quietly empty. `~/.dsh/profiles/web/cordis.patch.yml` is only needed when you want to override a price:

```yaml
- insert:
    - id: bill
      name: 'dsh-bill'
      config:
        priceOverrides:
          'anthropic/claude-sonnet-4-6':
            inputPerM: 3.0        # USD per million input tokens (uncached)
            outputPerM: 15.0
            cacheReadPerM: 0.3
            cacheWritePerM: 3.75
```

## Data and privacy

- each call's provider / model / token usage and attributed amounts are written to `$DSH_HOME/dsh-bill/records.jsonl` (a 20 000-entry ring buffer; older entries are folded into a rollup);
- the API key used for the account balance is read and used host-side and never reaches the browser;
- nothing is sent anywhere except the price catalogues, the exchange-rate endpoint, and the balance query; no conversation content is stored.

## Implementation

| Layer | How |
| --- | --- |
| Capture | hooks the `llm/stream` waterfall, wraps the stream to observe `usage` chunks, passes everything through untouched |
| Pricing | `llm-pricing` resolves catalogue / peak rate / override at the call's own instant |
| Attribution | the request is split into classified segments at capture time and apportioned by position in the cache prefix |
| Backfill | scans the session log for sessions it never recorded, deduplicating on `turn:step` |
| Per turn | the `billTurns` session projection folds the session log host-side and pushes to the client — no polling |
| Storage | in-memory ring buffer plus append-only JSONL, folded into a rollup before eviction; atomic replace and file locking borrowed from `dsh-atomic-write` |
| Transport | the `ctx.connection.rpc` channel `/dsh-bill` when there is one, falling back to `POST /dsh-bill/api` |
| UI | `conversation.view` / `conversation.chat.turnTail` / `conversation.composer.dock` / `sidebar.footer.action` / `settings.section`, built on the host's `--dsw-*` design tokens |

## License

MIT
