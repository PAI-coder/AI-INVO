/**
 * Copy engine: Invo live opens → Hyperliquid testnet orders.
 *
 * Hyperliquid is one-way (no hedge mode). Each Invo baseId is tracked
 * separately in data/copy/state.json; same-coin same-direction copies
 * are netted into one HL position.
 */
import { WALLET_ADDRESS } from '../env.js';
import * as hl from '../hl-client.js';
import { slug } from './slug.js';
import {
  isConfiguredPortfolio,
  configuredTraders,
  type CopyConfig,
} from './copy-config.js';
import {
  loadCopyState,
  saveCopyState,
  openCopies,
  type CopyRecord,
  type CopyState,
} from './copy-state.js';
import { alert, copyLog } from './copy-log.js';
import {
  listOpenPositions,
  listTraderPortfolioTitles,
  type PositionRow,
} from './portfolio-store.js';

const MIN_ENTRY_SIZE = 1e-9;
const HL_SLIPPAGE = 0.02;
/** Kill stuck HL API calls so one order cannot freeze the whole bot. */
const HL_ORDER_TIMEOUT_MS = 90_000;
const retriedSkips = new Set<string>();

function isRetryableSkip(copy: CopyRecord | undefined): boolean {
  if (!copy || copy.status !== 'skipped') return false;
  if (retriedSkips.has(copy.baseId)) return false;
  const reason = copy.skipReason ?? '';
  return /invalid price/i.test(reason) || /leverage .+ > HL max/i.test(reason);
}

function clampLeverage(requested: number, maxLeverage: number): { lev: number; capped: boolean } {
  const want = Math.floor(requested);
  const max = Math.max(1, Math.floor(maxLeverage));
  if (want > max) return { lev: max, capped: true };
  return { lev: want, capped: false };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function retryOrder(fn: () => Promise<any>): Promise<hl.OrderOutcome> {
  let last: hl.OrderOutcome = { ok: false, error: 'not attempted', raw: null };
  for (let i = 0; i < 3; i++) {
    if (i === 2) await sleep(15_000);
    try {
      const raw = await withTimeout(fn(), HL_ORDER_TIMEOUT_MS, 'HL order');
      last = hl.parseOrderResult(raw);
      if (last.ok) return last;
    } catch (e: any) {
      last = { ok: false, error: e?.message ?? String(e), raw: e };
    }
  }
  return last;
}

async function retryVoid(fn: () => Promise<any>): Promise<{ ok: boolean; error?: string; raw?: unknown }> {
  let last = 'not attempted';
  let raw: unknown = null;
  for (let i = 0; i < 3; i++) {
    if (i === 2) await sleep(15_000);
    try {
      raw = await fn();
      const status = (raw as any)?.status;
      if (status && status !== 'ok') {
        last = JSON.stringify(raw);
        continue;
      }
      return { ok: true, raw };
    } catch (e: any) {
      last = e?.message ?? String(e);
      raw = e;
    }
  }
  return { ok: false, error: last, raw };
}

function validEntrySize(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > MIN_ENTRY_SIZE;
}

function assetMeta(
  meta: { universe: { name: string; szDecimals: number; maxLeverage: number }[] },
  coin: string,
) {
  return meta.universe.find((a) => a.name === coin) ?? null;
}

function hlSignedSize(positions: any[], coin: string): number {
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) return 0;
  return parseFloat(pos.szi) || 0;
}

function oppositeOpen(state: CopyState, coin: string, direction: 'long' | 'short'): CopyRecord | undefined {
  const want = direction === 'long' ? 'short' : 'long';
  return openCopies(state).find((c) => c.coin === coin && c.direction === want);
}

/** Limit price HL uses on IOC market orders — min-notional is checked against this, not mid. */
function orderLimitPx(mid: number, direction: 'long' | 'short'): number {
  return direction === 'long' ? mid * (1 + HL_SLIPPAGE) : mid * (1 - HL_SLIPPAGE);
}

async function intendedHlSize(
  entrySize: number,
  coin: string,
  szDecimals: number,
  minNotionalUsd: number,
  direction: 'long' | 'short',
): Promise<{
  size: number;
  sizeStr: string;
  notional: number;
  mid: number;
  orderPx: number;
  pctNotional: number;
  usedMinFallback: boolean;
} | null> {
  const accountValue = await hl.getAccountValue(WALLET_ADDRESS);
  const mids = await hl.getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid || mid <= 0) return null;

  const orderPx = orderLimitPx(mid, direction);
  const pctNotional = accountValue * (entrySize / 100);
  const tick = 10 ** -szDecimals;

  // Priority 1: same % of our account as the trader uses on theirs.
  let size = Math.round(pctNotional / mid / tick) * tick;
  if (size <= 0) size = tick;

  let usedMinFallback = false;
  // Priority 2: HL rejects orders under $10 (checked as size × limit_px).
  if (size * orderPx + 1e-9 < minNotionalUsd) {
    usedMinFallback = true;
    size = Math.ceil(minNotionalUsd / orderPx / tick) * tick;
    while (size * orderPx + 1e-9 < minNotionalUsd) {
      size += tick;
    }
  }

  let sizeStr = hl.roundSz(size, szDecimals);
  size = parseFloat(sizeStr);
  if (!size || size <= 0) return null;

  while (size * orderPx + 1e-9 < minNotionalUsd) {
    size += tick;
    sizeStr = hl.roundSz(size, szDecimals);
    size = parseFloat(sizeStr);
    usedMinFallback = true;
  }

  return {
    size,
    sizeStr,
    notional: size * mid,
    mid,
    orderPx,
    pctNotional,
    usedMinFallback,
  };
}

async function cancelTrigger(coin: string, oid: number | null) {
  if (oid == null) return;
  try {
    await hl.cancelOid(coin, oid);
  } catch {
    /* already gone */
  }
}

async function syncTpsl(copy: CopyRecord, row: PositionRow) {
  const isLong = copy.direction === 'long';
  const tp = row.priceTarget;
  const sl = row.stopLoss;

  const tpChanged = (tp ?? null) !== (copy.priceTarget ?? null);
  const slChanged = (sl ?? null) !== (copy.stopLoss ?? null);
  if (!tpChanged && !slChanged && copy.tpOid == null && copy.slOid == null) {
    if (tp == null && sl == null) return;
  }

  if (tpChanged || (tp != null && copy.tpOid == null)) {
    await cancelTrigger(copy.coin, copy.tpOid);
    copy.tpOid = null;
    copy.priceTarget = tp ?? null;
    // TP on Invo means "trim" (partial reduce), not full close.
    // We intentionally do NOT place a TP trigger on HL; instead the
    // copy engine will react to the entrySize change after the Invo
    // trader's TP fires and resize our position proportionally.
  }

  if (slChanged || (sl != null && copy.slOid == null)) {
    await cancelTrigger(copy.coin, copy.slOid);
    copy.slOid = null;
    copy.stopLoss = sl ?? null;
    if (sl != null && copy.hlSize > 0) {
      const placed = await retryOrder(() =>
        hl.placeTriggerOrder({
          coin: copy.coin,
          isBuy: !isLong,
          size: String(copy.hlSize),
          triggerPx: sl,
          tpsl: 'sl',
          reduceOnly: true,
        }),
      );
      if (placed.ok) copy.slOid = placed.oid ?? null;
      else alert(`SL place failed ${copy.coin} ${copy.baseId}: ${placed.error}`);
    }
  }
}

function skipCopy(
  state: CopyState,
  row: PositionRow,
  reason: string,
) {
  const baseId = row.baseId!;
  alert(`SKIP ${row.trader}/${row.portfolioTitle} ${row.coin} ${row.direction} ${baseId}: ${reason}`);
  copyLog({
    action: 'skip',
    trader: row.trader,
    portfolio: row.portfolioTitle,
    coin: row.coin,
    direction: row.direction,
    baseId,
    entrySize: row.entrySize,
    leverage: row.leverage,
    reason,
  });
  state.copies[baseId] = {
    baseId,
    trader: row.trader,
    portfolio: row.portfolioTitle,
    coin: row.coin,
    direction: row.direction,
    leverage: row.leverage ?? 0,
    entrySize: validEntrySize(row.entrySize) ? row.entrySize : 0,
    hlSize: 0,
    hlEntryPrice: null,
    tpOid: null,
    slOid: null,
    priceTarget: row.priceTarget ?? null,
    stopLoss: row.stopLoss ?? null,
    status: 'skipped',
    skipReason: reason,
    updatedAt: new Date().toISOString(),
  };
}

export async function baselineIfNeeded(cfg: CopyConfig, state: CopyState) {
  // Always baseline on every startup: any Invo position that is currently open
  // and not already tracked as open by the bot gets added to ignoredBaseIds.
  // This ensures that when the bot restarts it never opens copies for trades
  // the trader already had open before this run started.
  const ignored = new Set(state.ignoredBaseIds);
  const alreadyTracked = new Set(
    Object.values(state.copies)
      .filter((c) => c.status === 'open')
      .map((c) => c.baseId),
  );
  let newlyIgnored = 0;
  for (const p of cfg.portfolios) {
    for (const row of listOpenPositions(p.trader, p.portfolio)) {
      if (row.baseId && !alreadyTracked.has(row.baseId) && !ignored.has(row.baseId)) {
        ignored.add(row.baseId);
        newlyIgnored++;
      }
    }
  }
  state.ignoredBaseIds = [...ignored];
  state.baselinedAt = new Date().toISOString();
  saveCopyState(state);
  if (newlyIgnored > 0) {
    copyLog({
      action: 'baseline',
      reason: `ignored ${newlyIgnored} new already-open Invo position(s) on startup`,
      detail: [...ignored].join('|'),
    });
    console.error(`[copy] baseline: ignoring ${newlyIgnored} new already-open Invo position(s)`);
  }
}

function alertNewPortfolios(cfg: CopyConfig, state: CopyState) {
  const alerted = new Set(state.alertedPortfolios);
  for (const trader of configuredTraders(cfg)) {
    for (const title of listTraderPortfolioTitles(trader)) {
      if (isConfiguredPortfolio(cfg, trader, title)) continue;
      const key = `${trader}::${slug(title)}`;
      if (alerted.has(key)) continue;
      alerted.add(key);
      alert(`New Invo portfolio not in copy-config.json — not copying: ${trader} / ${title}`);
    }
  }
  state.alertedPortfolios = [...alerted];
}

async function warnForeignPositions(state: CopyState) {
  const positions = await hl.getPositions(WALLET_ADDRESS);
  const ours = new Set(openCopies(state).map((c) => c.coin));
  const warned = new Set(state.warnedForeignCoins);
  for (const p of positions) {
    const coin = p.coin as string;
    if (ours.has(coin)) continue;
    if (warned.has(coin)) continue;
    warned.add(coin);
    alert(`HL has ${coin} position the bot did not open (left untouched)`);
  }
  state.warnedForeignCoins = [...warned];
}

async function markLiquidated(state: CopyState, coin: string) {
  for (const c of openCopies(state)) {
    if (c.coin !== coin) continue;
    c.status = 'dead';
    c.updatedAt = new Date().toISOString();
    alert(`WE were liquidated on HL for ${coin} (copy ${c.baseId}) — marked dead, will not reopen`);
    copyLog({
      action: 'our_liq',
      trader: c.trader,
      portfolio: c.portfolio,
      coin: c.coin,
      direction: c.direction,
      baseId: c.baseId,
      reason: 'HL position gone while Invo still open',
    });
  }
}

export async function closeCopy(state: CopyState, copy: CopyRecord, reason: string): Promise<boolean> {
  await cancelTrigger(copy.coin, copy.tpOid);
  await cancelTrigger(copy.coin, copy.slOid);
  copy.tpOid = null;
  copy.slOid = null;

  if (copy.hlSize > 0) {
    const positions = await hl.getPositions(WALLET_ADDRESS);
    const signed = hlSignedSize(positions, copy.coin);
    const abs = Math.abs(signed);
    const closeSz = Math.min(copy.hlSize, abs);
    if (closeSz > 0) {
      const isLong = copy.direction === 'long';
      const meta = await hl.getMeta();
      const asset = assetMeta(meta, copy.coin);
      const szDecimals = asset?.szDecimals ?? 4;
      const sizeStr = hl.roundSz(closeSz, szDecimals);
      if (parseFloat(sizeStr) > 0) {
        const result = await retryOrder(() =>
          hl.placeMarketOrder(copy.coin, !isLong, sizeStr, 0.02, true),
        );
        if (!result.ok) {
          alert(`Failed to close HL copy ${copy.coin} ${copy.baseId}: ${result.error}`);
          copyLog({
            action: 'close_fail',
            trader: copy.trader,
            portfolio: copy.portfolio,
            coin: copy.coin,
            direction: copy.direction,
            baseId: copy.baseId,
            hlSize: copy.hlSize,
            reason,
            detail: result.error,
          });
          return false;
        }
      }
    }
  }

  copy.status = 'closed';
  copy.hlSize = 0;
  copy.updatedAt = new Date().toISOString();
  copyLog({
    action: 'close',
    trader: copy.trader,
    portfolio: copy.portfolio,
    coin: copy.coin,
    direction: copy.direction,
    baseId: copy.baseId,
    reason,
  });
  console.error(`[copy] closed ${copy.trader}/${copy.portfolio} ${copy.coin} ${copy.direction} (${reason})`);
  return true;
}

async function openCopy(cfg: CopyConfig, state: CopyState, row: PositionRow, meta: Awaited<ReturnType<typeof hl.getMeta>>) {
  const baseId = row.baseId!;
  if (!validEntrySize(row.entrySize)) {
    skipCopy(state, row, 'invalid entrySize');
    return;
  }
  const levRaw = row.leverage;
  if (levRaw == null || !Number.isFinite(levRaw) || levRaw < 1) {
    skipCopy(state, row, 'invalid leverage');
    return;
  }

  const asset = assetMeta(meta, row.coin);
  if (!asset) {
    skipCopy(state, row, `coin not on Hyperliquid (${row.coin})`);
    return;
  }
  const { lev, capped } = clampLeverage(levRaw, asset.maxLeverage);
  if (capped) {
    alert(`Capped ${row.coin} ${baseId} leverage ${Math.floor(levRaw)}x → HL max ${lev}x`);
  }

  const opp = oppositeOpen(state, row.coin, row.direction);
  if (opp) {
    skipCopy(
      state,
      row,
      `HL is one-way: already have ${opp.direction} ${row.coin} from ${opp.trader}/${opp.portfolio}`,
    );
    return;
  }

  const positions = await hl.getPositions(WALLET_ADDRESS);
  const signed = hlSignedSize(positions, row.coin);
  const wantLong = row.direction === 'long';
  if (signed !== 0 && (signed > 0) !== wantLong) {
    skipCopy(state, row, `HL already has opposite ${row.coin} position (one-way)`);
    return;
  }

  const levRes = await retryVoid(() => hl.setLeverage(row.coin, lev));
  if (!levRes.ok) {
    skipCopy(state, row, `isolated leverage rejected: ${levRes.error}`);
    return;
  }

  const sized = await intendedHlSize(row.entrySize, row.coin, asset.szDecimals, cfg.minNotionalUsd, row.direction);
  if (!sized || sized.size <= 0) {
    skipCopy(state, row, 'could not compute HL size');
    return;
  }

  const withdrawable = await hl.getWithdrawable(WALLET_ADDRESS);
  const marginNeeded = sized.notional / lev;
  if (withdrawable + 1e-6 < marginNeeded) {
    skipCopy(
      state,
      row,
      `not enough margin (need ~$${marginNeeded.toFixed(2)}, free $${withdrawable.toFixed(2)})`,
    );
    return;
  }

  const result = await retryOrder(() =>
    hl.placeMarketOrder(row.coin, wantLong, sized.sizeStr, 0.02, false),
  );
  if (!result.ok) {
    skipCopy(state, row, `HL order failed: ${result.error}`);
    return;
  }

  const filledSz = result.totalSz ? parseFloat(result.totalSz) : sized.size;
  const copy: CopyRecord = {
    baseId,
    trader: row.trader,
    portfolio: row.portfolioTitle,
    coin: row.coin,
    direction: row.direction,
    leverage: lev,
    entrySize: row.entrySize,
    hlSize: filledSz || sized.size,
    hlEntryPrice: result.avgPx ? parseFloat(result.avgPx) : sized.mid,
    tpOid: null,
    slOid: null,
    priceTarget: null,
    stopLoss: null,
    status: 'open',
    openedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await syncTpsl(copy, row);
  state.copies[baseId] = copy;
  copyLog({
    action: 'open',
    trader: row.trader,
    portfolio: row.portfolioTitle,
    coin: row.coin,
    direction: row.direction,
    baseId,
    entrySize: row.entrySize,
    leverage: copy.leverage,
    hlSize: copy.hlSize,
    detail: `oid=${result.oid ?? ''} px=${copy.hlEntryPrice ?? ''} notional=$${sized.notional.toFixed(2)} pct=$${sized.pctNotional.toFixed(2)}${sized.usedMinFallback ? ` fallbackMin=$${cfg.minNotionalUsd}` : ''}${capped ? ` cappedLev=${Math.floor(levRaw)}x→${lev}x` : ''}`,
  });
  console.error(
    `[copy] opened ${row.trader}/${row.portfolioTitle} ${row.coin} ${row.direction} ${copy.leverage}x size=${copy.hlSize} (${row.entrySize.toFixed(4)}% → $${sized.notional.toFixed(2)}${sized.usedMinFallback ? `, HL min $${cfg.minNotionalUsd}` : ''}${capped ? `, capped ${Math.floor(levRaw)}x→${lev}x` : ''})`,
  );
}

async function resizeCopy(
  cfg: CopyConfig,
  copy: CopyRecord,
  row: PositionRow,
  meta: Awaited<ReturnType<typeof hl.getMeta>>,
) {
  if (!validEntrySize(row.entrySize)) return;
  const asset = assetMeta(meta, copy.coin);
  if (!asset) return;
  const sized = await intendedHlSize(row.entrySize, copy.coin, asset.szDecimals, cfg.minNotionalUsd, copy.direction);
  if (!sized || sized.size <= 0) return;

  const delta = sized.size - copy.hlSize;
  const deltaStr = hl.roundSz(Math.abs(delta), asset.szDecimals);
  const absDelta = parseFloat(deltaStr);
  if (absDelta <= 0) {
    copy.entrySize = row.entrySize;
    return;
  }

  const isLong = copy.direction === 'long';
  const isBuy = delta > 0 ? isLong : !isLong;
  const reduceOnly = delta < 0;
  let orderSz = absDelta;
  let orderSzStr = deltaStr;

  // Trims (incl. TP) under HL min: do not send, keep our size, close later with Invo.
  if (reduceOnly && orderSz * sized.mid + 1e-9 < cfg.minNotionalUsd) {
    copy.entrySize = row.entrySize;
    copy.updatedAt = new Date().toISOString();
    copyLog({
      action: 'resize_skip',
      trader: copy.trader,
      portfolio: copy.portfolio,
      coin: copy.coin,
      direction: copy.direction,
      baseId: copy.baseId,
      entrySize: copy.entrySize,
      hlSize: copy.hlSize,
      reason: `trim $${(orderSz * sized.mid).toFixed(2)} under HL min $${cfg.minNotionalUsd} — keeping HL size`,
    });
    console.error(
      `[copy] skipped tiny trim ${copy.coin} ${copy.baseId} $${(orderSz * sized.mid).toFixed(2)} — keeping size ${copy.hlSize}`,
    );
    return;
  }

  const addPx = isBuy ? sized.orderPx : orderLimitPx(sized.mid, copy.direction);
  // Adds must also meet HL's $10 min per order; bump the add if needed
  if (delta > 0 && orderSz * addPx + 1e-9 < cfg.minNotionalUsd) {
    const tick = 10 ** -asset.szDecimals;
    orderSz = Math.ceil(cfg.minNotionalUsd / addPx / tick) * tick;
    orderSzStr = hl.roundSz(orderSz, asset.szDecimals);
    orderSz = parseFloat(orderSzStr);
    while (orderSz * addPx + 1e-9 < cfg.minNotionalUsd) {
      orderSz += tick;
      orderSzStr = hl.roundSz(orderSz, asset.szDecimals);
      orderSz = parseFloat(orderSzStr);
    }
  }

  const result = await retryOrder(() =>
    hl.placeMarketOrder(copy.coin, isBuy, orderSzStr, 0.02, reduceOnly),
  );
  if (!result.ok) {
    if (reduceOnly) {
      copy.entrySize = row.entrySize;
      copy.updatedAt = new Date().toISOString();
    }
    alert(`Resize failed ${copy.coin} ${copy.baseId}: ${result.error}${reduceOnly ? ' — keeping HL size' : ''}`);
    return;
  }
  if (delta > 0) {
    const addPx = result.avgPx ? parseFloat(result.avgPx) : sized.mid;
    const oldPx = copy.hlEntryPrice;
    const oldSz = copy.hlSize;
    copy.hlSize = copy.hlSize + orderSz;
    if (oldPx && oldPx > 0 && addPx > 0 && copy.hlSize > 0) {
      copy.hlEntryPrice = (oldPx * oldSz + addPx * orderSz) / copy.hlSize;
    } else if (addPx > 0) {
      copy.hlEntryPrice = addPx;
    }
  } else {
    copy.hlSize = Math.max(0, copy.hlSize - orderSz);
  }
  copy.entrySize = row.entrySize;
  copy.updatedAt = new Date().toISOString();
  await cancelTrigger(copy.coin, copy.tpOid);
  await cancelTrigger(copy.coin, copy.slOid);
  copy.tpOid = null;
  copy.slOid = null;
  await syncTpsl(copy, row);
  copyLog({
    action: 'resize',
    trader: copy.trader,
    portfolio: copy.portfolio,
    coin: copy.coin,
    direction: copy.direction,
    baseId: copy.baseId,
    entrySize: copy.entrySize,
    hlSize: copy.hlSize,
    detail: `delta=${delta > 0 ? '+' : '-'}${orderSzStr}${sized.usedMinFallback ? ` minFallback=$${cfg.minNotionalUsd}` : ''}`,
  });
  console.error(`[copy] resized ${copy.coin} ${copy.baseId} → ${copy.hlSize} (entrySize ${copy.entrySize}%)`);
}

async function updateOpenCopy(
  cfg: CopyConfig,
  state: CopyState,
  copy: CopyRecord,
  row: PositionRow,
  meta: Awaited<ReturnType<typeof hl.getMeta>>,
) {
  if (row.direction !== copy.direction) {
    console.error(`[copy] direction flip ${copy.coin} ${copy.baseId}: ${copy.direction} → ${row.direction}`);
    const closed = await closeCopy(state, copy, 'direction flip');
    if (!closed) return;
    delete state.copies[copy.baseId];
    await openCopy(cfg, state, row, meta);
    return;
  }

  const levRaw = row.leverage;
  if (levRaw != null && Number.isFinite(levRaw) && levRaw >= 1) {
    const asset = assetMeta(meta, copy.coin);
    const maxLev = asset?.maxLeverage ?? copy.leverage;
    const { lev, capped } = clampLeverage(levRaw, maxLev);
    if (lev !== copy.leverage) {
      const levRes = await retryVoid(() => hl.setLeverage(copy.coin, lev));
      if (levRes.ok) {
        copy.leverage = lev;
        alert(
          `Updated HL leverage ${copy.coin} ${copy.baseId} → ${copy.leverage}x${capped ? ` (capped from ${Math.floor(levRaw)}x)` : ''}`,
        );
        copyLog({
          action: 'leverage',
          trader: copy.trader,
          portfolio: copy.portfolio,
          coin: copy.coin,
          baseId: copy.baseId,
          leverage: copy.leverage,
          detail: capped ? `capped from ${Math.floor(levRaw)}x` : undefined,
        });
      } else {
        alert(`Leverage update failed ${copy.coin}: ${levRes.error}`);
      }
    }
  }

  if (validEntrySize(row.entrySize) && row.entrySize !== copy.entrySize) {
    await resizeCopy(cfg, copy, row, meta);
  }

  await syncTpsl(copy, row);
  copy.updatedAt = new Date().toISOString();
}

export async function copyTick(cfg: CopyConfig, state: CopyState) {
  alertNewPortfolios(cfg, state);

  const live: PositionRow[] = [];
  for (const p of cfg.portfolios) {
    live.push(...listOpenPositions(p.trader, p.portfolio));
  }
  const liveById = new Map<string, PositionRow>();
  for (const row of live) {
    if (row.baseId) liveById.set(row.baseId, row);
  }

  for (const copy of openCopies(state)) {
    if (!liveById.has(copy.baseId)) {
      await closeCopy(state, copy, 'Invo position gone (close or liquidation)');
    }
  }

  const positions = await hl.getPositions(WALLET_ADDRESS);
  for (const copy of openCopies(state)) {
    if (copy.hlEntryPrice && copy.hlEntryPrice > 0) continue;
    const pos = positions.find((p: any) => p.coin === copy.coin);
    const px = parseFloat(pos?.entryPx);
    if (Number.isFinite(px) && px > 0) copy.hlEntryPrice = px;
  }
  const liveCoins = new Set(
    [...liveById.values()].filter((r) => r.baseId && !state.ignoredBaseIds.includes(r.baseId)).map((r) => r.coin),
  );
  for (const coin of new Set(openCopies(state).map((c) => c.coin))) {
    if (hlSignedSize(positions, coin) !== 0) continue;
    const stillWanted = openCopies(state).some((c) => c.coin === coin && liveById.has(c.baseId));
    if (stillWanted && liveCoins.has(coin)) {
      await markLiquidated(state, coin);
    }
  }

  await warnForeignPositions(state);

  const meta = await hl.getMeta();

  for (const row of live) {
    if (!row.baseId) continue;
    if (state.ignoredBaseIds.includes(row.baseId)) continue;
    const existing = state.copies[row.baseId];
    if (existing?.status === 'dead') continue;
    if (existing?.status === 'skipped' && !isRetryableSkip(existing)) continue;
    if (existing?.status === 'open') {
      await updateOpenCopy(cfg, state, existing, row, meta);
      continue;
    }
    if (existing?.status === 'closed') {
      const signed = hlSignedSize(positions, row.coin);
      const wantLong = row.direction === 'long';
      if (signed !== 0 && (signed > 0) === wantLong) {
        existing.status = 'open';
        existing.hlSize = Math.abs(signed);
        const pos = positions.find((p: any) => p.coin === row.coin);
        const px = parseFloat(pos?.entryPx);
        if (Number.isFinite(px) && px > 0) existing.hlEntryPrice = px;
        existing.updatedAt = new Date().toISOString();
        alert(`Resumed ${row.coin} ${row.baseId} after restart (kept HL position @ ${existing.hlEntryPrice})`);
        await updateOpenCopy(cfg, state, existing, row, meta);
        continue;
      }
    }
    if (existing?.status === 'skipped') {
      retriedSkips.add(row.baseId);
      alert(`Retrying ${row.coin} ${row.baseId} after skip (${existing.skipReason})`);
    }
    await openCopy(cfg, state, row, meta);
  }

  saveCopyState(state);
}

export async function closeAllManaged(state: CopyState) {
  for (const copy of openCopies(state)) {
    await closeCopy(state, copy, 'bot shutdown');
  }
  saveCopyState(state);
}

export async function heartbeat(state: CopyState) {
  try {
    const value = await hl.getAccountValue(WALLET_ADDRESS);
    const n = openCopies(state).length;
    console.error(`[copy] alive | copies=${n} | HL accountValue=${value.toFixed(2)} | network=${hl.getNetworkLabel()}`);
  } catch (e: any) {
    console.error(`[copy] heartbeat failed: ${e.message}`);
  }
}
