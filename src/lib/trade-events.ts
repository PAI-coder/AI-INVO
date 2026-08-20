export type TradeAction =
  | 'open'
  | 'close'
  | 'add'
  | 'trim'
  | 'tp'
  | 'sl'
  | 'update'
  | 'unknown';

export interface TradeEvent {
  id: string;
  postType: string | null;
  action: TradeAction;
  at: string | null;
  updatedAt: string | null;
  trader: string | null;
  traderId: string | null;
  coin: string | null;
  direction: 'long' | 'short' | null;
  leverage: number | null;
  entryPrice: number | null;
  closingPrice: number | null;
  currentPrice: number | null;
  entrySize: number | null;
  positionSize: number | null;
  entrySim: number | null;
  lastSim: number | null;
  priceTarget: number | null;
  stopLoss: number | null;
  liquidationPrice: number | null;
  isOpen: boolean | null;
  verifiedTrade: boolean | null;
  reasonClosed: string | null;
  changes: Record<string, unknown> | null;
  baseShortId: string | null;
  baseId: string | null;
  portfolioId: string | null;
  portfolioTitle: string | null;
  openPositionsCount: number | null;
  closedPositionsCount: number | null;
  winRate: number | null;
  pnl: number | null;
  content: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PositionBook {
  baseShortId: string;
  baseId: string | null;
  coin: string | null;
  direction: 'long' | 'short' | null;
  isOpenNow: boolean;
  latestAction: TradeAction;
  latestAt: string | null;
  eventCount: number;
  events: TradeEvent[];
  dexUpdates?: DexUpdate[];
  note?: string;
}

export interface DexUpdate {
  updateType: string;
  updatedAt: string;
  details: Record<string, unknown>;
  isMimicked?: boolean;
}

export function classifyAction(update: any, postType: string | null): TradeAction {
  if (!update) return 'unknown';
  const isOpen = update.isOpen === true;
  const isClosed = update.isOpen === false && update.closingPrice != null;
  const ch = update.changes ?? {};

  if (isClosed || ch.isOpen === false) return 'close';
  if (postType === 'investment' && isOpen && ch.isAdded == null && !update.closingPrice) return 'open';
  if (ch.isAdded === true) return 'add';
  if (ch.isAdded === false && isOpen) return 'trim';
  if (ch.priceTarget != null || update.priceTarget != null) return 'tp';
  if (ch.stopLoss != null || update.stopLoss != null) return 'sl';
  if (postType === 'update') return 'update';
  if (postType === 'investment') return isOpen ? 'open' : 'close';
  return 'unknown';
}

export function parseFeedPost(post: any, now: string): TradeEvent | null {
  const update = post.update ?? {};
  const owner = update.owner ?? post.owner ?? {};
  const portfolio = update.portfolio ?? {};
  const coin = update.ticker ?? update.name ?? null;
  if (!coin) return null;

  const postType = post.postTypeId ?? null;
  const action = classifyAction(update, postType);

  return {
    id: post.id,
    postType,
    action,
    at: post.createdAt ?? update.createdAt ?? null,
    updatedAt: update.updatedAt ?? post.updatedAt ?? post.createdAt ?? null,
    trader: owner.username ?? owner.name ?? null,
    traderId: owner.id ?? null,
    coin,
    direction: update.directionLong == null ? null : update.directionLong ? 'long' : 'short',
    leverage: update.leverage ?? null,
    entryPrice: update.entryPrice ?? null,
    closingPrice: update.closingPrice ?? null,
    currentPrice: update.currentPrice ?? null,
    entrySize: update.entrySize ?? null,
    positionSize: update.positionSize ?? null,
    entrySim: update.entrySim ?? null,
    lastSim: update.lastSim ?? null,
    priceTarget: update.priceTarget ?? null,
    stopLoss: update.stopLoss ?? null,
    liquidationPrice: update.liquidationPrice ?? null,
    isOpen: update.isOpen ?? null,
    verifiedTrade: update.verifiedTrade ?? null,
    reasonClosed: update.reasonClosed ?? null,
    changes: update.changes ?? null,
    baseShortId: update.baseShortId ?? null,
    baseId: update.baseId ?? update.id ?? null,
    portfolioId: portfolio.id ?? null,
    portfolioTitle: portfolio.title ?? 'Main',
    openPositionsCount: portfolio.openPositionsCount ?? null,
    closedPositionsCount: portfolio.closedPositionsCount ?? null,
    winRate: portfolio.winRate ?? null,
    pnl: portfolio.plSnapshot ?? null,
    content: post.content ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function eventSortKey(e: TradeEvent): string {
  return e.updatedAt ?? e.at ?? '';
}

export function mergeEvents(existing: TradeEvent[], incoming: TradeEvent[]): TradeEvent[] {
  const map = new Map<string, TradeEvent>();
  for (const e of existing) map.set(e.id, e);
  for (const e of incoming) {
    const prev = map.get(e.id);
    map.set(
      e.id,
      prev
        ? { ...prev, ...e, firstSeenAt: prev.firstSeenAt, lastSeenAt: e.lastSeenAt }
        : e,
    );
  }
  return Array.from(map.values()).sort((a, b) => eventSortKey(b).localeCompare(eventSortKey(a)));
}

export function groupIntoPositions(events: TradeEvent[]): PositionBook[] {
  const byBase = new Map<string, TradeEvent[]>();
  for (const e of events) {
    const key = e.baseShortId ?? e.baseId ?? e.id;
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key)!.push(e);
  }

  const positions: PositionBook[] = [];
  for (const [baseShortId, evs] of byBase) {
    const sorted = [...evs].sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
    const latest = sorted[sorted.length - 1];
    positions.push({
      baseShortId,
      baseId: latest.baseId,
      coin: latest.coin,
      direction: latest.direction,
      isOpenNow: latest.isOpen === true,
      latestAction: latest.action,
      latestAt: latest.updatedAt ?? latest.at,
      eventCount: sorted.length,
      events: sorted,
    });
  }

  return positions.sort((a, b) => (b.latestAt ?? '').localeCompare(a.latestAt ?? ''));
}

export function eventsToCsv(events: TradeEvent[]): string {
  const header =
    'id,action,postType,trader,coin,direction,leverage,entryPrice,closingPrice,currentPrice,entrySize,positionSize,isOpen,verifiedTrade,createdAt,updatedAt,baseShortId,portfolioTitle,reasonClosed\n';
  const rows = events
    .map((e) =>
      [
        e.id,
        e.action,
        e.postType,
        e.trader,
        e.coin,
        e.direction,
        e.leverage,
        e.entryPrice,
        e.closingPrice,
        e.currentPrice,
        e.entrySize,
        e.positionSize,
        e.isOpen,
        e.verifiedTrade,
        e.at,
        e.updatedAt,
        e.baseShortId,
        e.portfolioTitle,
        e.reasonClosed,
      ]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(','),
    )
    .join('\n');
  return header + rows + (rows ? '\n' : '');
}
