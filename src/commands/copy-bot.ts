/**
 * Copy bot — Hyperliquid only.
 *
 * Does NOT call the Invo API. The fetcher writes data/traders/ + data/summary.json;
 * this process copies to HL after each new snapshot.
 *
 * Run ALL THREE (three terminals):
 *   npx tsx src/commands/fetch-live-opens.ts --watch
 *   npx tsx src/commands/copy-bot.ts --watch
 *   npx tsx src/commands/watch-copy-bot.ts
 *
 * Ctrl+C leaves bot-managed HL positions open and remembers their entry price.
 */
import { existsSync, readFileSync, watch } from 'fs';
import { join } from 'path';
import {
  validateHlEnv,
  HL_AGENT_KEY,
  WALLET_ADDRESS,
  HL_NETWORK,
  isHlTestnet,
  hlWsUrl,
} from '../env.js';
import * as hl from '../hl-client.js';
import { loadCopyConfig } from '../lib/copy-config.js';
import { loadCopyState, openCopies, saveCopyState } from '../lib/copy-state.js';
import { alert, ensureCopyLogs, copyLog } from '../lib/copy-log.js';
import { peekInvoPollLock } from '../lib/invo-poll-lock.js';
import {
  baselineIfNeeded,
  copyTick,
  heartbeat,
} from '../lib/copy-engine.js';
import { clearCopyHeartbeat, writeCopyHeartbeat } from '../lib/copy-heartbeat.js';

validateHlEnv();

const SUMMARY_PATH = join(process.cwd(), 'data', 'summary.json');

function readFetchedAt(): string | null {
  if (!existsSync(SUMMARY_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
    return typeof data.fetchedAt === 'string' ? data.fetchedAt : null;
  } catch {
    return null;
  }
}

async function preflight() {
  const failures: string[] = [];

  if (!isHlTestnet()) {
    failures.push(`HL_NETWORK=${HL_NETWORK} — copy bot refuses to run on mainnet until you change this in code/.env on purpose`);
  }

  let cfg;
  try {
    cfg = loadCopyConfig();
  } catch (e: any) {
    failures.push(e.message);
    cfg = null;
  }
  if (cfg && cfg.network !== 'testnet') {
    failures.push(`copy-config.json network=${cfg.network} — must be testnet`);
  }

  try {
    await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS, { enableWs: true });
    const value = await hl.getAccountValue(WALLET_ADDRESS);
    const perp = parseFloat(((await hl.getAccountSummary(WALLET_ADDRESS)) as any)?.marginSummary?.accountValue ?? '0') || 0;
    const spot = await hl.getSpotUsdc(WALLET_ADDRESS);
    if (!(value > 0)) failures.push('HL accountValue is 0 — claim testnet USDC first');
    const wsOn = hl.isHlWsLive();
    console.error(
      `[preflight] HL ${hl.getNetworkLabel()} accountValue=${value} (perp=${perp} spotUsdc=${spot}) | websocket=${wsOn ? 'live' : 'off (REST fallback)'} ${hlWsUrl()}`,
    );
  } catch (e: any) {
    failures.push(`HL connect/account failed: ${e.message}`);
  }

  if (cfg) {
    console.error(
      `[preflight] copying: ${cfg.portfolios.map((p) => `${p.trader}/${p.portfolio}`).join(', ')}`,
    );
  }
  console.error('[preflight] Invo HTTP: off — waiting for fetcher snapshots in data/summary.json');
  console.error(
    '[preflight] note: Hyperliquid is one-way (no hedge mode). Same-coin copies are tracked separately in data/copy/ and netted on HL.',
  );

  if (failures.length) {
    for (const f of failures) console.error(`[preflight FAIL] ${f}`);
    process.exit(1);
  }

  return cfg!;
}

async function main() {
  ensureCopyLogs();
  clearCopyHeartbeat();
  writeCopyHeartbeat({ status: 'starting', openCopies: 0 });

  const cfg = await preflight();
  const state = loadCopyState();
  writeCopyHeartbeat({ status: 'starting', openCopies: openCopies(state).length });

  let shuttingDown = false;
  let inFlight = false;
  let pending = false;
  let processedAt: string | null = null;
  let waitingLogged = false;
  let staleAlerted = false;
  let tickError: string | null = null;
  let sessionBaselined = false;
  let tickStartedAt = 0;

  const runCopyFromDisk = async () => {
    if (shuttingDown) return;
    const fetchedAt = readFetchedAt();
    if (!fetchedAt) {
      if (!waitingLogged) {
        console.error('[copy] waiting for fetcher — start: npx tsx src/commands/fetch-live-opens.ts --watch');
        waitingLogged = true;
      }
      return;
    }
    if (fetchedAt === processedAt) return;
    if (inFlight) {
      pending = true;
      return;
    }

    inFlight = true;
    waitingLogged = false;
    tickStartedAt = Date.now();
    writeCopyHeartbeat({
      status: 'tick',
      openCopies: openCopies(state).length,
      lastSnapshot: fetchedAt,
    });
    try {
      // Baseline once per process start — ignore all Invo positions already open
      // before this run, so restarts never re-copy old trades.
      if (!sessionBaselined) {
        await baselineIfNeeded(cfg, state);
        sessionBaselined = true;
      }
      await copyTick(cfg, state);
      processedAt = fetchedAt;
      if (tickError) {
        alert(`HL recovered after: ${tickError}`);
        tickError = null;
      }
      console.error(`[copy] applied fetcher snapshot ${fetchedAt}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (tickError !== msg) {
        tickError = msg;
        alert(`copy tick failed: ${msg} (will retry)`);
      }
      console.error(`[copy] tick retry after: ${msg}`);
    } finally {
      writeCopyHeartbeat({
        status: 'idle',
        openCopies: openCopies(state).length,
        lastTickAt: new Date().toISOString(),
        lastSnapshot: fetchedAt ?? readFetchedAt(),
      });
      inFlight = false;
      tickStartedAt = 0;
      if (pending) {
        pending = false;
        void runCopyFromDisk();
      }
    }
  };

  const dataDir = join(process.cwd(), 'data');
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    if (existsSync(dataDir)) {
      watcher = watch(dataDir, (event, filename) => {
        if (filename && String(filename) !== 'summary.json') return;
        void runCopyFromDisk();
      });
    }
  } catch (e: any) {
    console.error(`[copy] file watch unavailable (${e.message}) — polling summary.json instead`);
  }

  // Backup: Windows watch can miss writes; this only reads a local file, never Invo.
  const filePoll = setInterval(() => {
    const lock = peekInvoPollLock();
    const fetchedAt = readFetchedAt();
    if (!fetchedAt) {
      void runCopyFromDisk();
      return;
    }
    const ageMs = Date.now() - Date.parse(fetchedAt);
    if (!lock && ageMs > 90_000 && !staleAlerted) {
      staleAlerted = true;
      alert('No new fetcher snapshot for 90s — keep fetch-live-opens.ts --watch running in another terminal.');
    }
    if (lock) staleAlerted = false;
    void runCopyFromDisk();
  }, 1000);

  void runCopyFromDisk();

  const alivePing = setInterval(() => {
    if (shuttingDown) return;
    // If stuck mid-tick (e.g. hung HL order), stop refreshing so watchdog restarts us.
    if (inFlight && tickStartedAt > 0 && Date.now() - tickStartedAt > 90_000) return;
    writeCopyHeartbeat({
      status: inFlight ? 'tick' : 'idle',
      openCopies: openCopies(state).length,
      lastSnapshot: readFetchedAt(),
    });
  }, 30_000);

  const hb = setInterval(() => {
    const fetchedAt = readFetchedAt();
    const lock = peekInvoPollLock();
    console.error(
      `[copy] waiting=${fetchedAt ? 'no' : 'yes'} | lastSnapshot=${fetchedAt ?? 'none'} | fetcher=${lock ? `${lock.owner} pid ${lock.pid}` : 'not running'}`,
    );
    void heartbeat(state);
  }, 60_000);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('[copy] shutting down — leaving HL positions open');
    writeCopyHeartbeat({ status: 'shutting_down', openCopies: openCopies(state).length });
    clearInterval(hb);
    clearInterval(alivePing);
    clearInterval(filePoll);
    watcher?.close();
    try {
      saveCopyState(state);
    } catch (e: any) {
      alert(`shutdown save failed: ${e.message}`);
    }
    const n = openCopies(state).length;
    const prices = openCopies(state)
      .map((c) => `${c.coin}@${c.hlEntryPrice ?? '?'}`)
      .join(', ');
    copyLog({
      action: 'shutdown',
      reason: `left ${n} HL position(s) open${prices ? ` (${prices})` : ''}`,
    });
    clearCopyHeartbeat();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
