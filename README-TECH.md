# Invo Copy Trader — Technical Reference

**Audience:** Developers, maintainers, and AI agents that need to understand where features live, how data flows, and how to trace behavior without reading the entire codebase.

**User-facing overview:** [README.md](./README.md)

**Repo root:** `invo-copy-trader/`

---

## Table of contents

1. [Runtime architecture](#runtime-architecture)
2. [End-to-end data flow](#end-to-end-data-flow)
3. [Module map](#module-map)
4. [Configuration schemas](#configuration-schemas)
5. [Disk layout & file contracts](#disk-layout--file-contracts)
6. [Copy state machine](#copy-state-machine)
7. [Copy engine (`copyTick`) algorithm](#copy-engine-copytick-algorithm)
8. [Sizing formula](#sizing-formula)
9. [Baseline & ignore logic](#baseline--ignore-logic)
10. [TP / SL / resize behavior](#tp--sl--resize-behavior)
11. [Hyperliquid client](#hyperliquid-client)
12. [Invo fetch path](#invo-fetch-path)
13. [Watchdog](#watchdog)
14. [Logging & alerts](#logging--alerts)
15. [Command entry points](#command-entry-points)
16. [Feature index (code locations)](#feature-index-code-locations)
17. [Tracing a single trade](#tracing-a-single-trade)
18. [Confirmed vs unconfirmed behavior](#confirmed-vs-unconfirmed-behavior)
19. [Common failure modes](#common-failure-modes)

---

## Runtime architecture

Three independent Node processes. Only the fetcher calls Invo HTTP. Copy-bot only reads local files and calls Hyperliquid.

| Process | Entry | `package.json` script | External I/O |
|---------|-------|----------------------|--------------|
| Fetcher | `src/commands/fetch-live-opens.ts` | `npm run watch` | Invo REST (+ optional WS/feed) → disk |
| Copy-bot | `src/commands/copy-bot.ts` | `npm run copy` | `data/summary.json` + `data/traders/` → HL API |
| Watchdog | `src/commands/watch-copy-bot.ts` | `npm run watchdog` | Reads heartbeat + summary; writes alerts |

**Lock file:** `data/invo-poll.lock` — owner `fetcher` while fetch-live-opens runs (`src/lib/invo-poll-lock.ts`). Copy-bot peeks lock for staleness checks but does not acquire it.

**TypeScript execution:** `tsx` runs `.ts` directly. Imports use `.js` extension (Node ESM resolution).

---

## End-to-end data flow

```
Invo API
  │  invo-client.ts (REST)
  │  invo-sync.ts (orchestration)
  │  invo-feed-lane.ts (5s following feed, optional)
  ▼
portfolio-store.ts
  │  syncPortfolioOpens(), listOpenPositions()
  ▼
data/traders/{trader}/{portfolio}/
  ├── open/{coin}__{baseId}.json
  ├── open.csv
  ├── closed/
  └── closed.csv
  │
  │  invo-sync also writes:
  ▼
data/summary.json  { fetchedAt, totalOpen, portfolios, errors }

copy-bot.ts
  │  watches summary.json (fs.watch + 1s interval)
  │  on new fetchedAt:
  ▼
copy-engine.ts
  │  baselineIfNeeded() → ignoredBaseIds
  │  copyTick() → openCopy / closeCopy / resizeCopy / syncTpsl
  ▼
hl-client.ts → Hyperliquid SDK (testnet)
  │
  ▼
data/copy/state.json, copy-log.csv, alerts.log, copy-bot.heartbeat.json
```

---

## Module map

### `src/env.ts`

Environment variables and validators.

| Export | Source | Used by |
|--------|--------|---------|
| `INVO_REFRESH_TOKEN`, `INVO_TOKEN` | `.env` | Fetcher, Invo commands |
| `HL_AGENT_KEY`, `WALLET_ADDRESS` | `.env` | HL commands, copy-bot |
| `HL_NETWORK` | `.env` (`testnet` default) | All HL |
| `INVO_WS_URL` | `.env` (optional) | `invo-ws.ts` |
| `validateEnv()` | — | Fetcher |
| `validateHlEnv()` | — | Copy-bot, HL commands |
| `isHlTestnet()`, `hlApiUrl()`, `hlWsUrl()` | — | `hl-client.ts` |

### `src/invo-client.ts`

Invo REST API wrapper: token refresh, portfolios, investments, feed, follow/unfollow.

### `src/hl-client.ts`

Hyperliquid SDK wrapper.

| Function | Purpose |
|----------|---------|
| `connect(agentKey, wallet, { enableWs })` | SDK init + optional WS |
| `getMeta()` | Universe, `szDecimals`, `maxLeverage` |
| `getAllMids()` | Mid prices map |
| `getAccountValue(wallet)` | Perp account value for sizing |
| `getPositions(wallet)` | Open perp positions |
| `setLeverage(coin, lev)` | Isolated leverage |
| `placeMarketOrder(coin, isBuy, sz, slippage, reduceOnly)` | IOC market |
| `placeTriggerOrder({ coin, triggerPx, tpsl, ... })` | SL triggers |
| `cancelOid(coin, oid)` | Cancel trigger |
| `parseOrderResult(raw)` | Normalize fill / error |
| `roundSz`, `roundPx` | HL decimal rules |

Constants: market slippage **2%** in `placeMarketOrder` default; copy-engine uses `HL_SLIPPAGE = 0.02` for limit_px sizing.

### `src/lib/portfolio-store.ts`

Disk persistence for Invo positions.

| Function | Purpose |
|----------|---------|
| `syncPortfolioOpens(...)` | Diff open list → write JSON/CSV, move to `closed/` |
| `listOpenPositions(trader, portfolio)` | Read `open/` → `PositionRow[]` |
| `listTraderPortfolioTitles(trader)` | Scan disk for portfolio folders |
| `TRADERS_ROOT` | `data/traders` |

**`PositionRow`** fields match `open.csv` columns; `baseId` is required for copy tracking.

### `src/lib/invo-sync.ts`

Shared sync used by fetcher.

| Function | Purpose |
|----------|---------|
| `runOnce(traderFilter?, forceRefresh?)` | Single poll cycle |
| `startHybridWatch(opts)` | Watch loop: REST interval + feed fast lane |
| `toRow(inv, ...)` | Invo API object → `PositionRow` |

Writes `data/summary.json` with `fetchedAt` ISO timestamp after each successful cycle.

Portfolio cache TTL: **10 minutes**. Followed feed TTL: **10 minutes**.

### `src/lib/copy-config.ts`

Loads `copy-config.json`.

| Function | Purpose |
|----------|---------|
| `loadCopyConfig()` | Parse + validate |
| `isConfiguredPortfolio(cfg, trader, title)` | Slug-normalized match |
| `configuredTraders(cfg)` | Unique trader names |

### `src/lib/copy-state.ts`

Persists `data/copy/state.json`.

| Type | Fields |
|------|--------|
| `CopyRecord` | `baseId`, trader, portfolio, coin, direction, leverage, entrySize, hlSize, hlEntryPrice, tpOid, slOid, priceTarget, stopLoss, status, skipReason?, openedAt?, updatedAt |
| `CopyState` | baselinedAt, ignoredBaseIds[], alertedPortfolios[], warnedForeignCoins[], copies{baseId→CopyRecord} |
| `CopyStatus` | `open` \| `closed` \| `skipped` \| `dead` |

| Function | Purpose |
|----------|---------|
| `loadCopyState()` / `saveCopyState()` | JSON persistence |
| `openCopies(state)` | Filter `status === 'open'` |

### `src/lib/copy-engine.ts`

**Core trading logic.** See [Copy engine algorithm](#copy-engine-copytick-algorithm).

| Export | Purpose |
|--------|---------|
| `baselineIfNeeded(cfg, state)` | Startup ignore list |
| `copyTick(cfg, state)` | Main sync loop |
| `closeCopy(state, copy, reason)` | Close one tracked copy on HL |
| `closeAllManaged(state)` | Close all open copies (not used on Ctrl+C) |
| `heartbeat(state)` | Console status line |

Internal: `openCopy`, `resizeCopy`, `updateOpenCopy`, `syncTpsl`, `intendedHlSize`, `markLiquidated`, `skipCopy`.

**Constants:**

- `HL_SLIPPAGE = 0.02`
- `HL_ORDER_TIMEOUT_MS = 90000`
- Order retries: 3 attempts, 15s sleep before last

### `src/lib/copy-log.ts`

| Path | Purpose |
|------|---------|
| `data/copy/copy-log.csv` | Structured action log |
| `data/copy/alerts.log` | Human alerts (append) |

`alert(msg)` → stderr + `alerts.log`.

### `src/lib/copy-heartbeat.ts`

| Path | `data/copy/copy-bot.heartbeat.json` |
| Writer | `copy-bot.ts` every 30s (and on tick start/end) |
| Reader | `watch-copy-bot.ts` |

Fields: `pid`, `startedAt`, `updatedAt`, `lastTickAt`, `lastSnapshot`, `openCopies`, `status` (`starting|idle|tick|shutting_down`).

`pidAlive(pid)` — Windows/Unix process check for watchdog.

### `src/lib/invo-feed-lane.ts`

Polls Invo following feed every ~5s for faster new-trade detection (when not `--no-fast-lane`).

### `src/lib/invo-ws.ts`

Experimental WebSocket client; enabled only if `INVO_WS_URL` set.

### `src/lib/slug.ts`

Normalizes trader/portfolio names for folder paths and config matching.

### `src/lib/trade-events.ts`

Feed event parsing for `sync-traders.ts`.

---

## Configuration schemas

### `copy-config.json`

```json
{
  "portfolios": [{ "trader": "string", "portfolio": "string" }],
  "network": "testnet",
  "marginMode": "isolated",
  "minNotionalUsd": 10,
  "pollIntervalSec": 15
}
```

Copy-bot **refuses to start** if `network !== 'testnet'` or `HL_NETWORK !== 'testnet'` (see `copy-bot.ts` preflight).

### `data/followed.json`

```json
{
  "traders": [{ "username": "string", "id": "uuid" }]
}
```

Fetcher merges this with traders already on disk and following feed.

### `.env` (execution-related)

```env
INVO_REFRESH_TOKEN=...
HL_NETWORK=testnet
WALLET_ADDRESS=0x...      # Main account (holds USDC)
HL_AGENT_KEY=0x...        # API wallet private key (trades only)
INVO_WS_URL=              # Optional
```

---

## Disk layout & file contracts

### Trader position JSON (`open/{coin}__{baseId}.json`)

Produced by `portfolio-store.ts` from `PositionRow`. Copy-bot reads via `listOpenPositions()`.

**Critical field:** `baseId` — Invo position UUID. Filename and `state.copies` key.

### `data/summary.json`

Written each fetcher cycle. Copy-bot triggers on **change** to `fetchedAt`:

```json
{
  "fetchedAt": "2026-08-20T07:26:55.408Z",
  "totalOpen": 12,
  "portfolios": [...],
  "errors": []
}
```

### `data/copy/state.json`

```json
{
  "baselinedAt": "ISO",
  "ignoredBaseIds": ["uuid", ...],
  "alertedPortfolios": ["trader::portfolio_slug"],
  "warnedForeignCoins": ["COIN"],
  "copies": {
    "baseId-uuid": { /* CopyRecord */ }
  }
}
```

---

## Copy state machine

Per `baseId` in `state.copies`:

```
                    baseline (ignoredBaseIds)
                           │
     new Invo open ───────┼──► openCopy() ──► open
                           │                    │
                           │                    ├── updateOpenCopy (leverage, resize, SL)
                           │                    │
                           │                    ├── closeCopy ──► closed
                           │                    │
                           │                    └── markLiquidated ──► dead
                           │
     openCopy failure ─────┼──► skipped ──► (retry if retryable skip)
                           │
     close-manual / wipe ──┼──► dead
```

**`ignoredBaseIds`:** copyTick never opens copies for these IDs (baseline + `close-manual.ts`).

**`dead`:** will not reopen for that `baseId` even if Invo still shows open (liquidation, manual wipe).

**Resume after restart:** If `status === 'closed'` but HL still has matching position and Invo still open → status reset to `open` and tracking resumes (`copyTick` lines ~726–738).

---

## Copy engine (`copyTick`) algorithm

Location: `src/lib/copy-engine.ts` → `export async function copyTick`

**Order of operations:**

1. `alertNewPortfolios` — warn if trader has portfolios not in `copy-config.json`
2. Build `liveById` from `listOpenPositions` for each configured portfolio
3. **Close pass:** for each `open` copy, if `baseId` not in `liveById` → `closeCopy(..., 'Invo position gone')`
4. Backfill `hlEntryPrice` from HL positions if missing
5. **Liquidation pass:** if HL `szi === 0` for coin but Invo still wants position → `markLiquidated`
6. `warnForeignPositions` — alert on HL positions not in our open copies
7. `meta = await hl.getMeta()`
8. **Open/update pass** for each live row:
   - Skip if no `baseId`
   - Skip if in `ignoredBaseIds`
   - Skip if `dead`
   - Skip if `skipped` and not retryable (`invalid price`, leverage > max)
   - If `open` → `updateOpenCopy`
   - If `closed` but HL position matches → resume as `open`
   - If `skipped` retryable → `openCopy`
   - Else → `openCopy`
9. `saveCopyState(state)`

### `openCopy` (summary)

Location: `copy-engine.ts` ~line 410

1. Check coin in HL meta universe → else `skipCopy`
2. `intendedHlSize(entrySize, ...)` → size or skip
3. Margin check vs `getWithdrawable`
4. `clampLeverage` vs `maxLeverage`
5. Handle opposite direction on same coin (close opposite copy first)
6. `setLeverage` isolated
7. `retryOrder(() => placeMarketOrder(...))`
8. Record `CopyRecord` status `open`, log to CSV

### `closeCopy` (summary)

Location: ~line 354

1. Cancel TP/SL triggers
2. Reduce-only market order for `copy.hlSize`
3. Status → `closed`, log

### `resizeCopy` (summary)

Location: ~line 519

When Invo `entrySize` changes (trim or add):

- Compute new intended HL size vs current `copy.hlSize`
- Place reduce-only or add market order for delta
- Update `copy.hlSize` and `entrySize`

**TP on Invo:** treated as trim → `entrySize` drops → `resizeCopy` (not HL TP order).

---

## Sizing formula

Location: `intendedHlSize()` in `copy-engine.ts`

```
accountValue = hl.getAccountValue(WALLET_ADDRESS)
mid = getAllMids()[coin]
orderPx = direction === 'long' ? mid * 1.02 : mid * 0.98   // HL_SLIPPAGE

pctNotional = accountValue * (entrySize / 100)              // Priority 1
size = round(pctNotional / mid, szDecimals)

if size * orderPx < minNotionalUsd:                          // Priority 2 ($10 default)
  size = ceil(minNotionalUsd / orderPx, tick)
  usedMinFallback = true
```

**Important:** Minimum check uses **order limit price** (mid ± 2%), not mid — matches HL rejection behavior.

Returns `null` if invalid mid → `skipCopy('invalid price')`.

---

## Baseline & ignore logic

Location: `baselineIfNeeded()` in `copy-engine.ts`

Called **once per copy-bot process** from `copy-bot.ts` when `sessionBaselined === false` (first tick with valid snapshot).

For each configured portfolio:

- Every row in `listOpenPositions(trader, portfolio)`
- If `baseId` not in open copies and not already ignored → add to `ignoredBaseIds`

Does **not** skip copies already `open` in state (restart with live HL positions).

`close-manual.ts` additionally adds all current Invo opens to `ignoredBaseIds` and marks copies `dead`.

---

## TP / SL / resize behavior

Location: `syncTpsl()` and `updateOpenCopy()` in `copy-engine.ts`

| Invo field | Bot behavior | Code |
|------------|--------------|------|
| `priceTarget` (TP) | **No HL TP order.** When trader hits TP, Invo reduces `entrySize` → `resizeCopy` | `syncTpsl` comment ~210–214 |
| `stopLoss` | Place HL trigger order `tpsl: 'sl'`, `reduceOnly: true` | `syncTpsl` ~216–233 |
| `entrySize` change | `resizeCopy` | `updateOpenCopy` ~668–670 |
| `leverage` change | `setLeverage` capped to max | `updateOpenCopy` ~640–665 |

---

## Hyperliquid client

File: `src/hl-client.ts`

- SDK package: `hyperliquid` ^1.7.7
- Network from `HL_NETWORK` env
- Copy-bot connects with `enableWs: true` for mids/account updates
- `close-manual.ts` uses `enableWs: false`

**One-way mode:** Multiple `CopyRecord` with same `coin` + direction share one HL position; engine nets via signed size checks (`hlSignedSize`).

---

## Invo fetch path

Entry: `src/commands/fetch-live-opens.ts`

1. `acquireInvoPollLock('fetcher')`
2. `startHybridWatch` or `runOnce`
3. `invo-sync` loops traders from `followed.json` + disk
4. For each portfolio: `get_investments(isOpen: true)` → `syncPortfolioOpens`
5. Write `summary.json` with new `fetchedAt`

Default REST interval: **15s**. Fast lane: **~5s** feed poll (`invo-feed-lane.ts`).

---

## Watchdog

File: `src/commands/watch-copy-bot.ts`

| Constant | Value | Meaning |
|----------|-------|---------|
| `CHECK_MS` | 30s | Poll interval |
| `STALE_MS` | 120s | Heartbeat older → problem |
| `WATCHDOG_STARTUP_GRACE_MS` | 90s | No alerts during grace |
| `ALERT_DEBOUNCE_MS` | 300s | Repeat alert spacing |

**Fetcher alive check:** `invo-poll.lock` owner `fetcher` with live pid OR `summary.json` age < 90s.

**Problem conditions:** no heartbeat file, pid dead, heartbeat stale.

**Action:** `alert('WATCHDOG: copy-bot ...')` only — **no process restart**.

---

## Logging & alerts

### `copy-log.csv` columns

`timestamp, action, trader, portfolio, coin, direction, baseId, entrySize, leverage, hlSize, reason, detail`

**Action examples:** `open`, `close`, `resize`, `skip`, `baseline`, `shutdown`, `our_liq`, `leverage`

### `alerts.log`

All `alert()` calls: skips, watchdog, foreign positions, errors, recovery messages.

---

## Command entry points

| File | `validateEnv` | `validateHlEnv` | Role |
|------|---------------|-----------------|------|
| `fetch-live-opens.ts` | ✓ | — | Fetcher |
| `copy-bot.ts` | — | ✓ | Copy engine driver |
| `watch-copy-bot.ts` | — | — | Watchdog |
| `close-manual.ts` | — | ✓ | Emergency close all |
| `hl-setup-check.ts` | — | ✓ | HL diagnostics |
| `trade.ts` / `close.ts` | — | ✓ | Manual HL |
| `sync-traders.ts` | ✓ | — | Feed history |
| `preflight.ts` | ✓ | partial | Checks |
| `discover.ts`, `follow.ts`, `monitor.ts`, `probe-ws.ts`, `verify.ts` | ✓ | — | Utilities |

### `copy-bot.ts` loop details

- `fs.watch(dataDir)` on `summary.json` changes
- Backup `setInterval` 1s reads `fetchedAt`, skips duplicate `processedAt`
- Heartbeat `setInterval` 30s (skipped if tick in-flight > 90s — allows watchdog to detect hang)
- Status log `setInterval` 60s
- **SIGINT/SIGTERM:** `shutdown()` — saves state, **does not** call `closeAllManaged`, clears heartbeat, exits

---

## Feature index (code locations)

| Feature | Primary location | Notes |
|---------|------------------|-------|
| Invo REST auth / refresh | `invo-client.ts` | |
| Portfolio discovery | `invo-sync.ts`, `portfolio-store.ts` | |
| Open/close on disk | `portfolio-store.ts` `syncPortfolioOpens` | |
| Following feed fast lane | `invo-feed-lane.ts` | ~5s |
| REST backup poll | `invo-sync.ts` `startHybridWatch` | default 15s |
| Single fetcher lock | `invo-poll-lock.ts` | |
| Copy config load | `copy-config.ts` | |
| Which portfolios copy | `copy-config.json` + `isConfiguredPortfolio` | |
| Startup ignore existing opens | `copy-engine.ts` `baselineIfNeeded` | |
| New open → HL order | `copy-engine.ts` `openCopy` | |
| Invo close → HL close | `copy-engine.ts` `closeCopy` | |
| entrySize % sizing | `copy-engine.ts` `intendedHlSize` | |
| $10 min fallback | `intendedHlSize` + `minNotionalUsd` | |
| Leverage set / cap | `openCopy`, `updateOpenCopy` | |
| Isolated margin | `hl-client.ts` `setLeverage` | |
| Resize / trim | `copy-engine.ts` `resizeCopy` | |
| Stop-loss on HL | `copy-engine.ts` `syncTpsl` | |
| Take-profit (trim) | `resizeCopy` via entrySize | No HL TP |
| Skip unknown coin | `openCopy` → `skipCopy` | |
| Skip low margin | `openCopy` | |
| Opposite direction same coin | `oppositeOpen`, close first | |
| Order timeout 90s | `withTimeout` in `retryOrder` | |
| Order retry 3x | `retryOrder`, `retryVoid` | |
| Our liquidation detect | `markLiquidated` | |
| Foreign HL position warn | `warnForeignPositions` | |
| Resume after restart | `copyTick` closed→open branch | |
| Heartbeat file | `copy-heartbeat.ts`, `copy-bot.ts` | |
| Watchdog alert | `watch-copy-bot.ts` | |
| Emergency close all | `close-manual.ts` | |
| Manual HL trade | `trade.ts`, `close.ts` | |
| HL setup check | `hl-setup-check.ts` | |
| Feed history sync | `sync-traders.ts`, `trade-events.ts` | |
| Testnet-only guard | `copy-bot.ts` `preflight` | |
| Ctrl+C leave positions | `copy-bot.ts` `shutdown` | |
| Slippage 2% | `hl-client.ts`, `HL_SLIPPAGE` | |
| Snapshot trigger | `copy-bot.ts` `runCopyFromDisk` | |
| Stale fetcher alert | `copy-bot.ts` filePoll 90s | |

---

## Tracing a single trade

Example: booobsas opens new kSHIB short.

1. **Fetcher** — Invo returns new investment → `syncPortfolioOpens` writes `data/traders/booobsas/$100 ➡️ $1M/open/kSHIB__{baseId}.json` and updates `open.csv`.
2. **Fetcher** — `summary.json` `fetchedAt` changes.
3. **Copy-bot** — `runCopyFromDisk` sees new `fetchedAt`.
4. **Baseline** — if first tick this session, `baselineIfNeeded` runs; this new `baseId` was not open at baseline → **not** ignored.
5. **copyTick** — row in `live`, not in `ignoredBaseIds`, no existing copy → `openCopy`.
6. **openCopy** — `intendedHlSize` with `entrySize` from JSON; maybe `usedMinFallback` if under $10.
7. **HL** — `setLeverage`, `placeMarketOrder` reduceOnly=false.
8. **State** — `state.copies[baseId]` status `open`, `hlSize`, `hlEntryPrice`.
9. **Logs** — row in `copy-log.csv` action `open`; console `[copy] applied fetcher snapshot ...`.
10. **Heartbeat** — `openCopies` count incremented.

To verify: grep `baseId` in `copy-log.csv`, `alerts.log`, and check `state.json`.

When trader closes on Invo:

1. Fetcher removes from `open/`, adds `closed/`, updates summary.
2. `copyTick` — copy `baseId` missing from `liveById` → `closeCopy`.
3. HL reduce-only market close.

---

## Confirmed vs unconfirmed behavior

### Confirmed in production logs / code path (~63 items)

Core loop, baseline, ignore on restart, open/close, $10 fallback with orderPx, skip non-HL coins, heartbeat, watchdog alerts, Ctrl+C no close, close-manual, resume tracking, liquidation mark dead, foreign position warn, fetcher lock, stale snapshot alert, testnet guard.

### Implemented but needs more live proof (~27 items)

TP trim via resize under fast markets, SL trigger fill behavior, leverage updates mid-trade, resize on large entrySize jumps, retry after skip, opposite-direction flip, WS mids vs REST mids, feed fast lane beating REST, multi-portfolio config, concurrent ticks with `pending` flag, margin edge cases near zero.

### Known limitations (do not treat as bugs)

1. HL testnet price ≠ Invo price
2. 15s poll gap (5s fast lane reduces but does not eliminate)
3. Flash open/close may miss
4. $10 minimum distorts tiny sizes
5. Isolated liquidation on volatile testnet
6. Illiquid / missing HL coins skipped
7. Fetcher may poll all `followed.json` traders even if only one in `copy-config.json`

---

## Common failure modes

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Restarts copy old trades | Baseline not run | `sessionBaselined`, `ignoredBaseIds` |
| Bot frozen | Hung HL order before timeout fix | `alerts.log`, heartbeat `status=tick` |
| Watchdog false positive | Stale pid in heartbeat | Restart copy-bot; 90s grace |
| Skip under $10 | Old code used mid not orderPx | `intendedHlSize` |
| `429` Invo | Multiple fetchers / fast poll | `invo-poll.lock`, interval |
| CRV / random skip | Coin not on HL | `skipCopy` reason in log |
| HL liq, Invo still open | `dead` status | `markLiquidated` |
| No copy activity | Fetcher down | `summary.json` age, Terminal 1 |
| Wrong size | `entrySize` null/0 on Invo row | open JSON, `validEntrySize` |

---

## Adding a new copied portfolio

1. Add trader to `data/followed.json` if not present (for fetcher).
2. Add `{ trader, portfolio }` to `copy-config.json`.
3. Restart fetcher (or wait for portfolio discovery on disk).
4. Restart copy-bot — **baseline will ignore current opens** for that portfolio; only new trades copied.

---

## Adding mainnet (not enabled)

Would require:

1. Remove/refactor testnet guards in `copy-bot.ts` preflight and `copy-config.json` validation.
2. Set `HL_NETWORK=mainnet` and mainnet API keys.
3. Re-test sizing with real margin — **high risk**.

Current code **intentionally refuses** mainnet for copy-bot.

---

*Last updated to match codebase state: booobsas / $100 ➡️ $1M, three-process stack, alert-only watchdog, baseline-on-every-startup.*
