# Invo Copy Trader

Automated copy-trading bot that watches traders on [Invo](https://app.invoapp.com), saves their live positions to disk, and mirrors **new** trades on [Hyperliquid](https://hyperliquid.xyz) **testnet** (paper money).

**Current live setup:** copying **booobsas** portfolio **$100 ➡️ $1M** only. Other traders in `data/followed.json` are still fetched for monitoring but are **not** copied unless added to `copy-config.json`.

---

## Table of contents

1. [What this bot does](#what-this-bot-does)
2. [What works today](#what-works-today)
3. [How to run (three terminals)](#how-to-run-three-terminals)
4. [How it works (big picture)](#how-it-works-big-picture)
5. [Copy trading rules](#copy-trading-rules)
6. [Configuration](#configuration)
7. [Project structure](#project-structure)
8. [Data on disk](#data-on-disk)
9. [Commands reference](#commands-reference)
10. [First-time setup](#first-time-setup)
11. [Daily usage & manual tools](#daily-usage--manual-tools)
12. [Known limitations](#known-limitations)
13. [Troubleshooting](#troubleshooting)
14. [Security & disclaimer](#security--disclaimer)

For developers and AI agents: see **[README-TECH.md](./README-TECH.md)** — module map, data flow, feature locations, state machine, and formulas.

---

## What this bot does

| Step | What happens |
|------|----------------|
| 1 | **Fetcher** polls Invo every ~15s and writes open/closed positions to `data/traders/` |
| 2 | **Copy-bot** reads those files (never calls Invo HTTP) and places orders on Hyperliquid testnet |
| 3 | **Watchdog** checks copy-bot heartbeat every 30s and **alerts** if the bot dies or hangs (no auto-restart) |

When a trader opens a **new** position after the bot started, the copy-bot opens a matching position on HL. When they close, trim, change leverage, or set stop-loss on Invo, the bot reacts on the next snapshot. **Ctrl+C on copy-bot leaves HL positions open** — state is saved so restarts can resume tracking.

On **every copy-bot startup**, all Invo positions already open are **ignored** — only trades opened *after* that run are copied. This prevents restart from re-copying old trades.

---

## What works today

| Feature | Status |
|---------|--------|
| Watch Invo live opens (~15s REST + optional 5s feed fast lane) | ✅ |
| Save positions to folders, CSV, JSON | ✅ |
| Detect opens / closes on disk (`closed/` + `closed.csv`) | ✅ |
| Sync feed history (`sync-traders.ts`) | ✅ |
| HL testnet connect, balance, manual trade/close | ✅ |
| **Auto copy: new Invo open → HL testnet order** | ✅ |
| Ignore existing Invo opens on startup (baseline) | ✅ |
| Position sizing: trader `entrySize` % → HL account % | ✅ |
| $10 HL minimum notional fallback | ✅ |
| Close when Invo position disappears | ✅ |
| Resize when trader changes `entrySize` (trim/add) | ✅ Implemented |
| Stop-loss trigger on HL when Invo sets `stopLoss` | ✅ Implemented |
| Take-profit: reacts to Invo trim via resize (no HL TP order) | ✅ By design |
| Leverage sync (capped to HL `maxLeverage`) | ✅ Implemented |
| Isolated margin mode | ✅ |
| Skip coins not on HL | ✅ |
| Skip when margin insufficient | ✅ |
| Detect our HL liquidation vs Invo still open | ✅ |
| Resume tracking after restart if HL position still open | ✅ |
| Order timeout (90s) so one stuck order cannot freeze bot | ✅ |
| Heartbeat file + alert-only watchdog | ✅ |
| `close-manual.ts` — close all HL + reset copy state | ✅ |
| Mainnet copy | ❌ Refused by copy-bot (testnet only) |

---

## How to run (three terminals)

All commands from the project folder:

```powershell
cd "C:\Users\ADMIN\Desktop\Invo - Where Traders Are Made\invo-copy-trader"
```

**Terminal 1 — Invo fetcher** (talks to Invo API):

```powershell
npm run watch
# or: npx tsx src/commands/fetch-live-opens.ts --watch
```

**Terminal 2 — Copy bot** (talks to Hyperliquid only):

```powershell
npm run copy
# or: npx tsx src/commands/copy-bot.ts --watch
```

**Terminal 3 — Watchdog** (alerts only, optional but recommended):

```powershell
npm run watchdog
# or: npx tsx src/commands/watch-copy-bot.ts
```

**npm shortcuts:** `npm run watch` | `npm run copy` | `npm run watchdog` | `npm run hl-check`

Keep all three running for 24/7 operation. If copy-bot stops, the watchdog writes to `data/copy/alerts.log` — restart copy-bot manually.

---

## How it works (big picture)

```
┌──────────────────────────────────────────────────────────────────┐
│  INVO (read-only)                                                │
│  • INVO_REFRESH_TOKEN → API calls                                │
│  • get_investments (isOpen) → live positions per portfolio       │
│  • Following feed fast lane (~5s) + REST backup (~15s)           │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  fetch-live-opens.ts --watch  (Terminal 1)                       │
│  • Writes data/traders/{trader}/{portfolio}/open|closed|csv       │
│  • Updates data/summary.json (fetchedAt timestamp)               │
│  • Holds data/invo-poll.lock as owner "fetcher"                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ disk only
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  copy-bot.ts --watch  (Terminal 2)                             │
│  • Watches data/summary.json (file watch + 1s poll backup)       │
│  • Baseline on startup → ignoredBaseIds for existing opens       │
│  • copyTick → open / close / resize / SL on Hyperliquid          │
│  • Heartbeat: data/copy/copy-bot.heartbeat.json every 30s        │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  HYPERLIQUID testnet                                             │
│  • Market orders (2% slippage IOC) via API wallet (HL_AGENT_KEY) │
│  • One-way mode — same-coin copies netted into one HL position   │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  watch-copy-bot.ts  (Terminal 3)                                 │
│  • Reads heartbeat; alerts if stale >120s or pid dead              │
│  • 90s startup grace; does NOT restart copy-bot                  │
└──────────────────────────────────────────────────────────────────┘
```

**Important:** Invo and Hyperliquid are separate systems. HL balance appears on the HL Portfolio page, not in MetaMask (unless you use the same wallet).

---

## Copy trading rules

### Who is copied

Defined in **`copy-config.json`** (not `followed.json`):

```json
{
  "portfolios": [
    { "trader": "booobsas", "portfolio": "$100 ➡️ $1M" }
  ],
  "network": "testnet",
  "marginMode": "isolated",
  "minNotionalUsd": 10,
  "pollIntervalSec": 15
}
```

`followed.json` controls which traders the **fetcher** polls. `copy-config.json` controls which portfolios the **copy-bot** trades.

### Sizing

1. **Primary:** `HL accountValue × (entrySize / 100)` — same portfolio % as the trader uses on Invo.
2. **Fallback:** If `size × orderLimitPx < $10`, size up to meet Hyperliquid's $10 minimum (checked against limit price with 2% slippage, not mid).

### Startup baseline (ignore existing opens)

On each copy-bot process start, every Invo position already open (and not already tracked as `open` in state) is added to `ignoredBaseIds`. Only positions that appear **after** that baseline are copied.

### Shutdown (Ctrl+C)

Copy-bot **does not close** HL positions. It saves `state.json` with entry prices and leaves positions open. On next start, baseline ignores old Invo opens; if HL still has a position for a live Invo trade, tracking **resumes**.

### Same coin, multiple Invo trades

Hyperliquid is **one-way** (no hedge mode). Multiple Invo `baseId` copies on the same coin/direction are tracked separately in `state.json` but appear as **one net HL position**.

---

## Configuration

| File | Purpose |
|------|---------|
| `.env` | Secrets: `INVO_REFRESH_TOKEN`, `HL_NETWORK`, `WALLET_ADDRESS`, `HL_AGENT_KEY` |
| `copy-config.json` | Which portfolios to copy + HL settings |
| `data/followed.json` | Traders the fetcher watches on Invo |

### `.env` minimum

```env
INVO_REFRESH_TOKEN=eyJ...
HL_NETWORK=testnet
WALLET_ADDRESS=0x...
HL_AGENT_KEY=0x...
```

---

## Project structure

```
invo-copy-trader/
├── .env                    # Secrets (never commit)
├── copy-config.json        # Copy targets + HL settings
├── README.md               # This file (overview)
├── README-TECH.md          # Technical reference for developers/AI
├── package.json
├── data/
│   ├── followed.json       # Traders to fetch from Invo
│   ├── summary.json        # Last fetcher snapshot timestamp
│   ├── invo-poll.lock      # Single fetcher lock
│   ├── copy/
│   │   ├── state.json      # Copy records, ignoredBaseIds
│   │   ├── copy-log.csv    # All copy actions
│   │   ├── alerts.log      # Alerts (watchdog, skips, errors)
│   │   └── copy-bot.heartbeat.json
│   └── traders/
│       └── {trader}/{portfolio}/
│           ├── open/           # One JSON per live position
│           ├── closed/         # Positions removed from open list
│           ├── open.csv        # Rewritten every poll
│           └── closed.csv      # Append-only close history
└── src/
    ├── env.ts
    ├── invo-client.ts
    ├── hl-client.ts
    ├── lib/
    │   ├── copy-engine.ts      # Core: open/close/resize/baseline
    │   ├── copy-state.ts
    │   ├── copy-config.ts
    │   ├── copy-log.ts
    │   ├── copy-heartbeat.ts
    │   ├── invo-sync.ts        # Fetcher sync logic
    │   ├── portfolio-store.ts  # Disk layout for positions
    │   └── ...
    └── commands/
        ├── fetch-live-opens.ts # Terminal 1
        ├── copy-bot.ts         # Terminal 2
        ├── watch-copy-bot.ts   # Terminal 3
        ├── close-manual.ts     # Emergency: close all HL
        ├── trade.ts / close.ts # Manual HL orders
        └── ...
```

---

## Data on disk

### Position files

- **`open/{COIN}__{baseId}.json`** — one file per open Invo position (`baseId` is the stable UUID).
- **`open.csv`** — table snapshot; rewritten every poll.
- **`closed/`** — position left Invo's open list; moved here once.
- **`closed.csv`** — append-only close log.

### Key `open.csv` columns

| Column | Meaning |
|--------|---------|
| `coin` | Ticker (BTC, ETH, kSHIB, …) |
| `direction` | `long` or `short` |
| `leverage` | e.g. 20 = 20x |
| `entrySize` | **% of portfolio** on Invo — used for our sizing |
| `entryPrice` / `currentPrice` | Invo prices |
| `priceTarget` / `stopLoss` | TP / SL if set |
| `baseId` | UUID — **primary key** for copy tracking |

### Copy state (`data/copy/state.json`)

- `ignoredBaseIds` — Invo positions we will never copy (baseline + manual close).
- `copies` — map of `baseId` → `CopyRecord` (`open` | `closed` | `skipped` | `dead`).
- `baselinedAt` — last baseline timestamp.

---

## Commands reference

```powershell
npx tsx src/commands/<file>.ts [options]
```

### Core (three-terminal stack)

| Command | Purpose |
|---------|---------|
| `fetch-live-opens.ts --watch` | Poll Invo, write `data/traders/` |
| `copy-bot.ts --watch` | Copy to HL testnet from disk |
| `watch-copy-bot.ts` | Alert if copy-bot unhealthy |

### Hyperliquid

| Command | Purpose |
|---------|---------|
| `hl-setup-check.ts` | Network, balance, positions |
| `trade.ts SOL long 0.01 2` | Manual open |
| `close.ts SOL` | Manual close one coin |
| `close-manual.ts` | Close **all** HL positions + reset copy state |

### Invo monitoring

| Command | Purpose |
|---------|---------|
| `fetch-live-opens.ts` | One-time fetch |
| `fetch-live-opens.ts --trader booobsas` | One trader only |
| `fetch-live-opens.ts --watch --interval 30` | 30s poll interval |
| `sync-traders.ts` | Feed history sync |

### Utilities

| Command | Purpose |
|---------|---------|
| `preflight.ts` | Env + Invo + HL checks |
| `verify.ts` | Endpoint health |
| `discover.ts` / `follow.ts` | Invo trader discovery |

---

## First-time setup

### Prerequisites

- Node.js 18+ (22+ recommended)
- Invo account + refresh token
- Hyperliquid testnet wallet + API key (for copy trading)

### Install

```powershell
cd "C:\Users\ADMIN\Desktop\Invo - Where Traders Are Made\invo-copy-trader"
npm install
copy .env.example .env
```

Edit `.env` with `INVO_REFRESH_TOKEN` and HL testnet keys.

### Invo token

1. Log in at https://app.invoapp.com
2. DevTools → Application → Local Storage → extract refresh token (see your setup notes for decrypt if encrypted)
3. Put in `.env` as `INVO_REFRESH_TOKEN=eyJ...`

### HL testnet

1. https://app.hyperliquid-testnet.xyz — claim mock USDC (faucet/drip)
2. API page → Generate API wallet → Authorize
3. `.env`: `HL_NETWORK=testnet`, `WALLET_ADDRESS` (main), `HL_AGENT_KEY` (API wallet private key)
4. Verify: `npm run hl-check`

### First fetch

```powershell
npx tsx src/commands/fetch-live-opens.ts --refresh
```

Check `data/traders/booobsas/$100 ➡️ $1M/open.csv` and `data/summary.json`.

---

## Daily usage & manual tools

### Watch only (no HL orders)

```powershell
npm run watch
```

### Full copy stack

Start all three terminals (see [How to run](#how-to-run-three-terminals)).

### Emergency: close everything on HL

```powershell
npx tsx src/commands/close-manual.ts
```

Closes all HL positions, marks copies `dead`, adds all current Invo opens to `ignoredBaseIds`. After this, only **new** Invo trades are copied.

### Fresh trader data

Delete contents of `data/traders/` and `data/summary.json`. Keep `data/followed.json` and `copy-config.json`.

### Rate limits

Default 15s Invo poll avoids 429 errors. Avoid multiple fetchers or `--refresh` in watch mode unless needed.

---

## Known limitations

| # | Limitation |
|---|------------|
| 1 | **Testnet prices ≠ Invo prices** — fills and PnL will differ from what the trader sees |
| 2 | **~15s polling gap** — very fast open/close may be missed between polls |
| 3 | **$10 minimum** — tiny trader sizes are bumped up on HL |
| 4 | **Isolated margin** — small positions can liquidate on volatile moves |
| 5 | **Coins not on HL** — skipped (e.g. some tickers only on Invo) |
| 6 | **Fetcher may still poll all traders in `followed.json`** — only `copy-config.json` portfolios are traded |
| 7 | **Watchdog alerts only** — does not restart copy-bot automatically |
| 8 | **Mainnet blocked** — copy-bot refuses `HL_NETWORK=mainnet` until intentionally changed |

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| `Missing INVO_REFRESH_TOKEN` | Add token to `.env` |
| Copy-bot copies old trades on restart | Should not happen with baseline — check `ignoredBaseIds` in `state.json` |
| `429` rate limit | Increase `--interval 30`, stop duplicate fetchers |
| No new fetcher snapshot | Keep Terminal 1 running; check `data/summary.json` `fetchedAt` |
| Watchdog false alert on startup | Wait 90s grace; start copy-bot before or right after watchdog |
| Stale pid in heartbeat | Copy-bot clears heartbeat on start; restart copy-bot |
| HL balance $0 | Claim testnet USDC; verify `WALLET_ADDRESS` |
| Coin skipped "not on HL" | Normal — coin not in HL universe |
| Bot hung overnight | 90s order timeout added; check `alerts.log` and restart |

---

## Security & disclaimer

- **Never commit** `.env`, private keys, or refresh tokens.
- `HL_AGENT_KEY` can trade but not withdraw (HL design) — still treat as secret.
- **Not affiliated** with Invo or Hyperliquid.

**Use at your own risk.** Leveraged trading can lose money quickly. Unofficial APIs may change. Past trader performance does not guarantee future results. You are responsible for laws in your region and safeguarding credentials.

---

## Quick reference

```powershell
npm install
npm run watch      # Terminal 1 — Invo
npm run copy       # Terminal 2 — HL copy
npm run watchdog   # Terminal 3 — alerts
npm run hl-check   # HL balance check
```

**Technical deep-dive:** [README-TECH.md](./README-TECH.md)
