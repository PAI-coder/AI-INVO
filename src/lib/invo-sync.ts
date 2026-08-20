/**
 * Shared Invo open-position sync used by fetch-live-opens and copy-bot.
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { INVO_WS_URL } from '../env.js';
import * as invo from '../invo-client.js';
import { slug } from './slug.js';
import { startInvoWebSocket } from './invo-ws.js';
import { startFeedFastLane } from './invo-feed-lane.js';
import { touchInvoPollLock, type PollOwner } from './invo-poll-lock.js';
import {
  syncPortfolioOpens,
  upsertTraderMeta,
  TRADERS_ROOT,
  type PositionRow,
} from './portfolio-store.js';

type PortfolioRef = { id: string; title: string; openCount: number; ids: string[] };

const FOLLOWED_PATH = join(process.cwd(), 'data', 'followed.json');

const portfolioCache = new Map<
  string,
  { traderId: string; portfolios: PortfolioRef[]; cachedAt: number }
>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const FOLLOWED_FEED_TTL_MS = 10 * 60 * 1000;
let lastFollowedFeedAt = 0;

export interface SyncResult {
  fetchedAt: string;
  root: string;
  totalOpen: number;
  closedThisRun: number;
  portfolios: {
    trader: string;
    portfolio: string;
    open: number;
    closedThisRun: string[];
  }[];
  errors: { trader: string; portfolio: string; error: string }[];
}

export interface WatchHandle {
  stop: () => void;
  runSync: (source: string, force?: boolean) => Promise<void>;
}

function toRow(
  inv: any,
  trader: string,
  portfolioTitle: string,
  portfolioId: string,
  fetchedAt: string,
): PositionRow {
  return {
    trader,
    portfolioTitle,
    portfolioId,
    coin: inv.ticker ?? inv.name ?? '?',
    direction: inv.directionLong ? 'long' : 'short',
    leverage: inv.leverage ?? null,
    entryPrice: inv.entryPrice ?? null,
    currentPrice: inv.currentPrice ?? null,
    entrySize: inv.entrySize ?? null,
    positionSize: inv.positionSize ?? null,
    liquidationPrice: inv.liquidationPrice ?? null,
    priceTarget: inv.priceTarget ?? null,
    stopLoss: inv.stopLoss ?? null,
    baseShortId: inv.baseShortId ?? null,
    baseId: inv.baseId ?? inv.id ?? null,
    updatedAt: inv.updatedAt ?? null,
    fetchedAt,
    changes: inv.changes ?? null,
  };
}

function loadFollowed(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(FOLLOWED_PATH)) return map;
  try {
    const data = JSON.parse(readFileSync(FOLLOWED_PATH, 'utf8'));
    for (const t of data.traders ?? []) {
      if (t.username && t.id) map.set(t.username, t.id);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function saveFollowed(traders: Map<string, string>) {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    FOLLOWED_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        traders: [...traders].map(([username, id]) => ({ username, id })),
      },
      null,
      2,
    ),
  );
}

export async function getFollowedTraders(opts?: { refreshFromFeed?: boolean }): Promise<Map<string, string>> {
  const traders = loadFollowed();
  const needFeed =
    opts?.refreshFromFeed === true ||
    traders.size === 0 ||
    lastFollowedFeedAt === 0 ||
    Date.now() - lastFollowedFeedAt > FOLLOWED_FEED_TTL_MS;

  // Do not hit the Following feed on every 15s poll — that was extra rate-limit load.
  if (needFeed) {
    try {
      const following = await invo.getFeedPages('following', 1, 25);
      for (const p of following) {
        const o = p.update?.owner ?? p.owner;
        if (o?.id && o?.username) traders.set(o.username, o.id);
      }
      lastFollowedFeedAt = Date.now();
    } catch {
      /* keep saved list */
    }
  }

  if (existsSync(TRADERS_ROOT)) {
    try {
      for (const dir of readdirSync(TRADERS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const metaPath = join(TRADERS_ROOT, dir.name, '_meta.json');
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (meta.trader && meta.traderId) traders.set(meta.trader, meta.traderId);
      }
    } catch {
      /* ignore */
    }
  }

  if (traders.size > 0) saveFollowed(traders);
  return traders;
}

function loadPortfoliosFromDisk(traderName: string): PortfolioRef[] | null {
  const metaPath = join(TRADERS_ROOT, slug(traderName), '_meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const list = (meta.portfolios ?? [])
      .filter((p: any) => p.portfolioId && p.portfolioTitle)
      .map((p: any) => ({
        id: p.portfolioId as string,
        title: p.portfolioTitle as string,
        openCount: p.openCount ?? 0,
        ids: [p.portfolioId as string],
      }));
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

async function discoverPortfolios(traderId: string, traderName: string): Promise<PortfolioRef[]> {
  const byId = new Map<string, { id: string; title: string; openCount: number }>();

  const data = await invo.getUserPortfolios(traderId);
  const items: any[] = data.items ?? data.portfolios ?? [];
  for (const p of items) {
    if (!p?.id) continue;
    const ownerName = p.owner?.username ?? p.user?.username;
    const ownerId = p.owner?.id ?? p.user?.id;
    if (ownerName && ownerName !== traderName) continue;
    if (ownerId && ownerId !== traderId) continue;
    byId.set(p.id, {
      id: p.id,
      title: ((p.title as string) || 'Main').trim(),
      openCount: (p.openPositions ?? p.openCount ?? 0) as number,
    });
  }

  const bySlug = new Map<string, PortfolioRef>();
  for (const p of byId.values()) {
    const key = slug(p.title);
    const prev = bySlug.get(key);
    if (!prev) bySlug.set(key, { ...p, ids: [p.id] });
    else prev.ids.push(p.id);
  }
  return [...bySlug.values()];
}

async function getPortfolios(
  traderId: string,
  traderName: string,
  forceRefresh: boolean,
): Promise<PortfolioRef[]> {
  const cached = portfolioCache.get(traderName);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.portfolios;
  }

  if (!forceRefresh) {
    const fromDisk = loadPortfoliosFromDisk(traderName);
    if (fromDisk && fromDisk.length > 0) {
      portfolioCache.set(traderName, { traderId, portfolios: fromDisk, cachedAt: Date.now() });
      return fromDisk;
    }
  }

  const portfolios = await discoverPortfolios(traderId, traderName);
  portfolioCache.set(traderName, { traderId, portfolios, cachedAt: Date.now() });
  return portfolios;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOpens(
  trader: string,
  portfolioIds: string[],
  portfolioTitle: string,
  primaryPortfolioId: string,
  fetchedAt: string,
): Promise<PositionRow[]> {
  const byKey = new Map<string, PositionRow>();
  const ids = [...new Set(portfolioIds.length ? portfolioIds : [primaryPortfolioId])];
  for (const portfolioId of ids.slice(0, 1)) {
    const data = await invo.getPortfolioInvestments(portfolioId, {
      isOpen: true,
      page: 1,
      size: 50,
    });
    const tickers: any[] = data.investmentsTicker ?? [];
    for (const t of tickers.filter((x) => x.isOpen === true)) {
      const row = toRow(t, trader, portfolioTitle, primaryPortfolioId, fetchedAt);
      const key = row.baseId || row.baseShortId || row.coin;
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes(' 429') || msg.toLowerCase().includes('too many requests');
}

export function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes(' 401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('refresh failed');
}

export async function runOnce(traderFilter?: string, forceRefresh = false): Promise<SyncResult> {
  const fetchedAt = new Date().toISOString();
  const traders = await getFollowedTraders();
  const summary: SyncResult['portfolios'] = [];
  const errors: SyncResult['errors'] = [];
  let totalOpen = 0;
  let totalClosed = 0;

  for (const [name, id] of traders) {
    if (traderFilter && name !== traderFilter) continue;

    const portfolios = await getPortfolios(id, name, forceRefresh);
    const metaPortfolios: { portfolioTitle: string; portfolioId: string; openCount: number }[] = [];

    for (const p of portfolios) {
      try {
        const opens = await fetchOpens(name, p.ids, p.title, p.id, fetchedAt);
        const result = syncPortfolioOpens(name, p.title, p.id, opens);
        totalOpen += result.openCount;
        totalClosed += result.closedThisRun.length;
        metaPortfolios.push({
          portfolioTitle: p.title,
          portfolioId: p.id,
          openCount: result.openCount,
        });

        summary.push({
          trader: name,
          portfolio: p.title,
          open: result.openCount,
          closedThisRun: result.closedThisRun.map((c) => `${c.coin} ${c.leverage}x ${c.direction}`),
        });
        await sleep(250);
      } catch (e: any) {
        errors.push({ trader: name, portfolio: p.title, error: e.message });
        if (isRateLimitError(e)) throw e;
        if (isAuthError(e)) throw e;
      }
    }

    if (metaPortfolios.length > 0) upsertTraderMeta(name, id, metaPortfolios);
  }

  if (!existsSync(join(process.cwd(), 'data'))) mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  const out: SyncResult = {
    fetchedAt,
    root: TRADERS_ROOT,
    totalOpen,
    closedThisRun: totalClosed,
    portfolios: summary,
    errors,
  };
  writeFileSync(
    join(process.cwd(), 'data', 'summary.json'),
    JSON.stringify(
      {
        ...out,
        layout: [
          'data/traders/{trader}/{portfolio}/open/',
          'data/traders/{trader}/{portfolio}/closed/',
          'data/traders/{trader}/{portfolio}/open.csv',
          'data/traders/{trader}/{portfolio}/closed.csv',
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(out, null, 2));
  return out;
}

export function startHybridWatch(opts: {
  traderFilter?: string;
  intervalSec?: number;
  noFastLane?: boolean;
  /** REST poll only — no 5s feed lane and no WebSocket. */
  restOnly?: boolean;
  /** 15s REST always; Invo WebSocket extra if INVO_WS_URL is set. Never uses 5s feed. */
  wsIfAvailable?: boolean;
  wsOnly?: boolean;
  forceRefresh?: boolean;
  printStatus?: boolean;
  afterSync?: (result: SyncResult, source: string) => Promise<void>;
  onSyncError?: (err: Error, source: string) => void;
  lockOwner?: PollOwner;
}): WatchHandle {
  const intervalSec = opts.intervalSec ?? 15;
  const printStatus = opts.printStatus !== false;
  const restOnly = opts.restOnly === true;
  const wsIfAvailable = opts.wsIfAvailable === true;
  const noFastLane = restOnly || wsIfAvailable || opts.noFastLane === true;
  const stoppers: Array<{ stop: () => void }> = [];
  let stopped = false;
  let backoffSec = 0;
  let syncInFlight = false;
  let syncQueued = false;
  let backupTimer: ReturnType<typeof setTimeout> | null = null;
  let lockBeat: ReturnType<typeof setInterval> | null = null;

  const runSync = async (source: string, force = false) => {
    if (stopped) return;
    if (syncInFlight) {
      syncQueued = true;
      return;
    }
    syncInFlight = true;
    if (opts.lockOwner) touchInvoPollLock(opts.lockOwner);
    try {
      if (printStatus && source !== 'rest-backup') {
        console.error(`[${source}] refreshing open positions…`);
      }
      const result = await runOnce(opts.traderFilter, force);
      backoffSec = 0;
      if (opts.lockOwner) touchInvoPollLock(opts.lockOwner);
      if (opts.afterSync) await opts.afterSync(result, source);
    } catch (e: any) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`[${source} error]`, err.message);
      opts.onSyncError?.(err, source);
      if (isRateLimitError(err)) {
        backoffSec = backoffSec ? Math.min(backoffSec * 2, 120) : 30;
        console.error(`[rate limit] backing off ${backoffSec}s…`);
      }
    } finally {
      syncInFlight = false;
      if (syncQueued && !stopped) {
        syncQueued = false;
        void runSync('queued');
      }
    }
  };

  const scheduleBackup = () => {
    if (stopped) return;
    const wait = Math.max(intervalSec, backoffSec) * 1000;
    backupTimer = setTimeout(async () => {
      await runSync('rest-backup');
      if (backoffSec > 0) backoffSec = Math.max(0, backoffSec - intervalSec);
      scheduleBackup();
    }, wait);
  };

  void (async () => {
    if (printStatus) {
      if (restOnly) {
        console.error(`REST watch every ${intervalSec}s (no 5s feed, no WebSocket). Ctrl+C to stop.`);
      } else if (wsIfAvailable) {
        console.error(
          INVO_WS_URL
            ? `REST every ${intervalSec}s + Invo WebSocket. Ctrl+C to stop.`
            : `REST every ${intervalSec}s (no Invo WebSocket URL set). Ctrl+C to stop.`,
        );
      } else {
        const fastLane = INVO_WS_URL ? 'websocket' : opts.wsOnly ? 'none' : noFastLane ? 'none' : 'feed';
        console.error(
          `Hybrid watch: fast=${fastLane} + REST backup every ${intervalSec}s (portfolios cached ${CACHE_TTL_MS / 60000}m). Ctrl+C to stop.`,
        );
      }
    }

    await runSync('startup', opts.forceRefresh || true);
    if (stopped) return;

    if (opts.lockOwner) {
      lockBeat = setInterval(() => touchInvoPollLock(opts.lockOwner!), 10_000);
    }

    const useInvoWs = Boolean(INVO_WS_URL) && !restOnly;
    if (restOnly || (wsIfAvailable && !useInvoWs)) {
      scheduleBackup();
      return;
    }

    if (INVO_WS_URL) {
      console.error(`[ws] INVO_WS_URL=${INVO_WS_URL}`);
      try {
        stoppers.push(
          startInvoWebSocket({
            url: INVO_WS_URL,
            getToken: async () => {
              await invo.ensureToken();
              return invo.getAccessToken();
            },
            onSignal: () => void runSync('websocket'),
            onStatus: (msg) => console.error(`[ws] ${msg}`),
          }),
        );
      } catch (e: any) {
        console.error(`[ws] failed to start: ${e.message}`);
        if (opts.wsOnly) process.exit(1);
      }
    } else if (opts.wsOnly) {
      console.error('[ws] --ws-only requires INVO_WS_URL in .env');
      process.exit(1);
    } else if (!noFastLane) {
      console.error(
        '[ws] INVO_WS_URL not set — fast lane uses Following feed every 5s (add WS URL from DevTools when you have it)',
      );
      const followedNames = new Set([...(await getFollowedTraders()).keys()]);
      stoppers.push(
        startFeedFastLane({
          intervalSec: 5,
          followedUsernames: followedNames,
          onSignal: () => void runSync('feed-fast'),
          onStatus: (msg) => console.error(`[fast] ${msg}`),
        }),
      );
    }

    scheduleBackup();
  })();

  return {
    runSync,
    stop: () => {
      stopped = true;
      if (backupTimer) clearTimeout(backupTimer);
      if (lockBeat) clearInterval(lockBeat);
      for (const s of stoppers) s.stop();
    },
  };
}
