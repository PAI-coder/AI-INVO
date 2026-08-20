/**
 * Clear on-disk layout:
 *
 *   data/traders/{trader}/{portfolio}/
 *     open/                 — one JSON file per live position
 *     closed/               — positions that left open/
 *     open.csv              — rewritten every poll (current snapshot)
 *     closed.csv            — append-only when a position closes
 *     _meta.json
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { slug } from './slug.js';

export const TRADERS_ROOT = join(process.cwd(), 'data', 'traders');

export interface PositionRow {
  trader: string;
  portfolioTitle: string;
  portfolioId: string;
  coin: string;
  direction: 'long' | 'short';
  leverage: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  closingPrice?: number | null;
  entrySize: number | null;
  positionSize: number | null;
  liquidationPrice: number | null;
  priceTarget: number | null;
  stopLoss: number | null;
  baseShortId: string | null;
  baseId: string | null;
  updatedAt: string | null;
  fetchedAt: string;
  closedAt?: string;
  changes?: Record<string, unknown> | null;
}

const OPEN_CSV_HEADERS = [
  'trader',
  'portfolio',
  'coin',
  'direction',
  'leverage',
  'entryPrice',
  'currentPrice',
  'entrySize',
  'positionSize',
  'liquidationPrice',
  'priceTarget',
  'stopLoss',
  'baseShortId',
  'baseId',
  'updatedAt',
  'fetchedAt',
] as const;

const CLOSED_CSV_HEADERS = [
  ...OPEN_CSV_HEADERS.slice(0, -1),
  'closingPrice',
  'closedAt',
  'fetchedAt',
] as const;

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Stable file key — baseId (UUID) beats baseShortId (API sometimes omits the short id). */
export function canonicalPositionKey(p: Pick<PositionRow, 'coin' | 'baseShortId' | 'baseId'>): string {
  const id = p.baseId || p.baseShortId || 'unknown';
  return `${slug(p.coin, 'COIN')}__${slug(id)}`;
}

/** All keys that may refer to the same live position (handles flaky API id fields). */
export function positionKeyAliases(p: Pick<PositionRow, 'coin' | 'baseShortId' | 'baseId'>): string[] {
  const keys = new Set<string>([canonicalPositionKey(p)]);
  if (p.baseId) keys.add(`${slug(p.coin, 'COIN')}__${slug(p.baseId)}`);
  if (p.baseShortId) keys.add(`${slug(p.coin, 'COIN')}__${slug(p.baseShortId)}`);
  return [...keys];
}

export function portfolioDir(trader: string, portfolioTitle: string): string {
  return join(TRADERS_ROOT, slug(trader), slug(portfolioTitle));
}

export function ensurePortfolioLayout(trader: string, portfolioTitle: string) {
  const dir = portfolioDir(trader, portfolioTitle);
  ensureDir(join(dir, 'open'));
  ensureDir(join(dir, 'closed'));
  return dir;
}

function openCsvPath(dir: string) {
  return join(dir, 'open.csv');
}

function closedCsvPath(dir: string) {
  return join(dir, 'closed.csv');
}

function writeOpenCsv(dir: string, rows: PositionRow[]) {
  const lines = [
    OPEN_CSV_HEADERS.join(','),
    ...rows.map((r) =>
      [
        r.trader,
        r.portfolioTitle,
        r.coin,
        r.direction,
        r.leverage,
        r.entryPrice,
        r.currentPrice,
        r.entrySize,
        r.positionSize,
        r.liquidationPrice,
        r.priceTarget,
        r.stopLoss,
        r.baseShortId,
        r.baseId,
        r.updatedAt,
        r.fetchedAt,
      ]
        .map(csvEscape)
        .join(','),
    ),
  ];
  writeFileSync(openCsvPath(dir), lines.join('\n') + '\n');
}

function appendClosedCsv(dir: string, row: PositionRow) {
  const path = closedCsvPath(dir);
  const line = [
    row.trader,
    row.portfolioTitle,
    row.coin,
    row.direction,
    row.leverage,
    row.entryPrice,
    row.currentPrice,
    row.entrySize,
    row.positionSize,
    row.liquidationPrice,
    row.priceTarget,
    row.stopLoss,
    row.baseShortId,
    row.baseId,
    row.updatedAt,
    row.closingPrice ?? '',
    row.closedAt ?? '',
    row.fetchedAt,
  ]
    .map(csvEscape)
    .join(',');

  if (!existsSync(path)) {
    writeFileSync(path, CLOSED_CSV_HEADERS.join(',') + '\n' + line + '\n');
    return;
  }
  const existing = readFileSync(path, 'utf8');
  writeFileSync(path, existing.endsWith('\n') ? existing + line + '\n' : existing + '\n' + line + '\n');
}

function listOpenFiles(dir: string): string[] {
  const openDir = join(dir, 'open');
  if (!existsSync(openDir)) return [];
  return readdirSync(openDir).filter((f) => f.endsWith('.json'));
}

function readOpenPosition(dir: string, file: string): PositionRow | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'open', file), 'utf8')) as PositionRow;
  } catch {
    return null;
  }
}

/**
 * Sync live opens into portfolio folder:
 * - upsert each open position under open/
 * - rewrite open.csv
 * - any previously open position missing from live list → move to closed/ + append closed.csv
 */
export function syncPortfolioOpens(
  trader: string,
  portfolioTitle: string,
  portfolioId: string,
  liveOpens: PositionRow[],
): { openCount: number; closedThisRun: PositionRow[] } {
  const dir = ensurePortfolioLayout(trader, portfolioTitle);
  const now = new Date().toISOString();
  const closedThisRun: PositionRow[] = [];

  const liveAliasKeys = new Set(liveOpens.flatMap(positionKeyAliases));

  // Close anything that disappeared from the live list
  for (const file of listOpenFiles(dir)) {
    const key = file.replace(/\.json$/, '');
    const prev = readOpenPosition(dir, file);
    const aliases = prev ? positionKeyAliases(prev) : [key];
    if (aliases.some((a) => liveAliasKeys.has(a))) {
      // Drop stale filename if API id field flipped (short ↔ uuid)
      const canon = prev ? canonicalPositionKey(prev) : key;
      if (key !== canon) unlinkSync(join(dir, 'open', file));
      continue;
    }

    if (!prev) {
      unlinkSync(join(dir, 'open', file));
      continue;
    }

    const closed: PositionRow = {
      ...prev,
      closedAt: now,
      closingPrice: prev.currentPrice ?? null,
      fetchedAt: now,
    };

    const closedFile = join(dir, 'closed', file);
    writeFileSync(closedFile, JSON.stringify(closed, null, 2));
    unlinkSync(join(dir, 'open', file));
    appendClosedCsv(dir, closed);
    closedThisRun.push(closed);
  }

  // Upsert current opens (always canonical uuid-based filename)
  for (const row of liveOpens) {
    const key = canonicalPositionKey(row);
    writeFileSync(join(dir, 'open', `${key}.json`), JSON.stringify(row, null, 2));
  }

  writeOpenCsv(dir, liveOpens);

  writeFileSync(
    join(dir, '_meta.json'),
    JSON.stringify(
      {
        trader,
        portfolioTitle,
        portfolioId,
        updatedAt: now,
        openCount: liveOpens.length,
        closedThisRun: closedThisRun.length,
      },
      null,
      2,
    ),
  );

  return { openCount: liveOpens.length, closedThisRun };
}

export function listOpenPositions(trader: string, portfolioTitle: string): PositionRow[] {
  const dir = ensurePortfolioLayout(trader, portfolioTitle);
  const rows: PositionRow[] = [];
  for (const file of listOpenFiles(dir)) {
    const row = readOpenPosition(dir, file);
    if (row) rows.push(row);
  }
  return rows;
}

export function listTraderPortfolioTitles(trader: string): string[] {
  const traderDir = join(TRADERS_ROOT, slug(trader));
  if (!existsSync(traderDir)) return [];
  const titles: string[] = [];
  for (const ent of readdirSync(traderDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const metaPath = join(traderDir, ent.name, '_meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      titles.push((meta.portfolioTitle as string) || ent.name);
    } catch {
      titles.push(ent.name);
    }
  }
  return titles;
}

export function upsertTraderMeta(
  trader: string,
  traderId: string | null,
  portfolios: { portfolioTitle: string; portfolioId: string; openCount: number }[],
) {
  const traderDir = join(TRADERS_ROOT, slug(trader));
  ensureDir(traderDir);
  const now = new Date().toISOString();
  const metaPath = join(traderDir, '_meta.json');
  let meta: any = { trader, traderId, createdAt: now, portfolios: [] };
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      /* keep default */
    }
  }
  meta.trader = trader;
  meta.traderId = traderId ?? meta.traderId ?? null;
  meta.updatedAt = now;
  if (!meta.createdAt) meta.createdAt = now;

  const byId = new Map<string, any>((meta.portfolios ?? []).map((p: any) => [p.portfolioId || p.portfolioTitle, p]));
  for (const p of portfolios) {
    const key = p.portfolioId || p.portfolioTitle;
    byId.set(key, {
      ...(byId.get(key) ?? {}),
      portfolioTitle: p.portfolioTitle,
      portfolioId: p.portfolioId,
      openCount: p.openCount,
      updatedAt: now,
    });
  }
  meta.portfolios = [...byId.values()];
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/** Write feed history into the same portfolio folder (does not touch open/closed). */
export function writeFeedEvents(
  trader: string,
  portfolioTitle: string,
  portfolioId: string | null,
  events: unknown[],
  csv: string,
) {
  const dir = ensurePortfolioLayout(trader, portfolioTitle);
  writeFileSync(
    join(dir, 'feed-events.json'),
    JSON.stringify(
      {
        trader,
        portfolioTitle,
        portfolioId,
        updatedAt: new Date().toISOString(),
        eventCount: events.length,
        events,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'feed-events.csv'), csv);
}
