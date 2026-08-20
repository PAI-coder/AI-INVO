import { createRequire } from 'module';
import { Hyperliquid } from 'hyperliquid';
import { hlApiUrl, isHlTestnet } from './env.js';

const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };

/** Node 20 has no native WebSocket. The HL SDK looks for `require('ws')` and `globalThis.WebSocket`. */
function ensureNodeWebSocket() {
  const g = globalThis as any;
  try {
    const req = createRequire(import.meta.url);
    if (typeof g.require !== 'function') g.require = req;
    if (typeof g.WebSocket !== 'function') {
      const ws = req('ws');
      g.WebSocket = ws.WebSocket ?? ws;
    }
  } catch {
    /* REST fallback still works */
  }
}
ensureNodeWebSocket();

function toSdkCoin(coin: string): string {
  return coin.includes('-') ? coin : `${coin}-PERP`;
}

let sdk: Hyperliquid | null = null;
let midsCache: Record<string, string> = {};
let midsAt = 0;
let accountCache: any = null;
let accountAt = 0;
let wsFeedsOn = false;

const WS_CACHE_FRESH_MS = 10_000;

function rawCoin(name: string): string {
  return String(name).replace(/-PERP$/i, '');
}

function cacheMids(data: Record<string, unknown>) {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v == null) continue;
    next[rawCoin(k)] = String(v);
  }
  if (Object.keys(next).length === 0) return;
  midsCache = next;
  midsAt = Date.now();
}

function cacheAccount(data: any) {
  if (!data || typeof data !== 'object') return;
  const state = data.clearinghouseState ?? data;
  if (!state?.assetPositions && !state?.marginSummary) return;
  if (Array.isArray(state.assetPositions)) {
    for (const p of state.assetPositions) {
      if (p?.position?.coin) p.position.coin = rawCoin(p.position.coin);
      if (p?.coin) p.coin = rawCoin(p.coin);
    }
  }
  accountCache = state;
  accountAt = Date.now();
}

async function startHlWsFeeds(walletAddress: string) {
  wsFeedsOn = false;
  const s = getSdk();
  if (!s.isWebSocketConnected()) {
    console.error('[hl] websocket not connected — using REST');
    return;
  }
  try {
    await s.subscriptions.subscribeToAllMids((data) => {
      cacheMids(data as unknown as Record<string, unknown>);
    });
    await s.subscriptions.subscribeToWebData2(walletAddress, (data) => {
      cacheAccount(data);
    });
    const ready = await waitUntil(() => Object.keys(midsCache).length > 0, 4_000);
    wsFeedsOn = ready;
    console.error(
      ready
        ? `[hl] websocket live (mids + account) ${getNetworkLabel()}`
        : '[hl] websocket connected but no mids yet — REST until first snapshot',
    );
  } catch (e: any) {
    console.error(`[hl] websocket subscribe failed: ${e?.message ?? e} — using REST`);
  }
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

export async function connect(
  agentKey: string,
  walletAddress: string,
  opts?: { enableWs?: boolean },
): Promise<Hyperliquid> {
  ensureNodeWebSocket();
  const testnet = isHlTestnet();
  const enableWs = opts?.enableWs !== false;
  sdk = new Hyperliquid({
    privateKey: agentKey,
    walletAddress,
    testnet,
    enableWs,
    maxReconnectAttempts: 50,
  });
  await sdk.connect();
  if (enableWs) await startHlWsFeeds(walletAddress);
  return sdk;
}

export function isHlWsLive(): boolean {
  return wsFeedsOn && isHlWsConnected() && Object.keys(midsCache).length > 0;
}

export function isHlWsConnected(): boolean {
  try {
    return getSdk().isWebSocketConnected();
  } catch {
    return false;
  }
}

export function isHlWsEnabled(): boolean {
  try {
    return getSdk().isWebSocketEnabled();
  } catch {
    return false;
  }
}

export function getSdk(): Hyperliquid {
  if (!sdk) throw new Error('HL SDK not connected. Call connect() first.');
  return sdk;
}

export function getNetworkLabel(): string {
  return isHlTestnet() ? 'testnet' : 'mainnet';
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function infoRequest(body: Record<string, unknown>) {
  const backoffMs = [0, 400, 1000, 2500];
  let lastErr: Error = new Error('HL info request failed');

  for (let i = 0; i < backoffMs.length; i++) {
    if (backoffMs[i]) await sleep(backoffMs[i]);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    try {
      const resp = await fetch(`${hlApiUrl()}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await resp.text();
      const trimmed = text.trim();
      if (!resp.ok) {
        throw new Error(`HL info HTTP ${resp.status}`);
      }
      if (!trimmed || trimmed.startsWith('<')) {
        throw new Error('HL info returned HTML instead of JSON');
      }
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error('HL info returned non-JSON');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') lastErr = new Error('HL info request timed out');
      else lastErr = e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

export async function getMeta() {
  return (await infoRequest({ type: 'meta' })) as {
    universe: { name: string; szDecimals: number; maxLeverage: number }[];
  };
}

export async function getAllMids(): Promise<Record<string, string>> {
  if (Object.keys(midsCache).length > 0 && Date.now() - midsAt < WS_CACHE_FRESH_MS) {
    return midsCache;
  }
  try {
    const rest = (await infoRequest({ type: 'allMids' })) as Record<string, string>;
    cacheMids(rest);
    return midsCache;
  } catch (e) {
    if (Object.keys(midsCache).length > 0) return midsCache;
    throw e;
  }
}

export async function getAccountSummary(wallet: string) {
  if (accountCache && Date.now() - accountAt < WS_CACHE_FRESH_MS) {
    return accountCache;
  }
  try {
    const data = await infoRequest({ type: 'clearinghouseState', user: wallet });
    cacheAccount(data);
    return data;
  } catch (e) {
    if (accountCache) return accountCache;
    throw e;
  }
}

export async function getPositions(wallet: string) {
  const data: any = await getAccountSummary(wallet);
  return (data.assetPositions ?? [])
    .filter((p: any) => parseFloat(p.position.szi) !== 0)
    .map((p: any) => p.position);
}

export async function setLeverage(coin: string, leverage: number) {
  const s = getSdk();
  return s.exchange.updateLeverage(toSdkCoin(coin), 'isolated', leverage);
}

/** Perps: prices may have at most 6 - szDecimals decimal places, and 5 significant figures. */
const PERP_MAX_DECIMALS = 6;

export function pxMaxDecimals(szDecimals: number): number {
  return Math.max(0, PERP_MAX_DECIMALS - Math.max(0, szDecimals));
}

function priceTick(px: number, szDecimals: number): number {
  const decTick = 10 ** -pxMaxDecimals(szDecimals);
  if (!Number.isFinite(px) || px <= 0) return decTick;
  const sigTick = 10 ** (Math.floor(Math.log10(px)) - 4);
  return Math.max(decTick, sigTick);
}

export function roundPx(
  px: number,
  szDecimals = 0,
  mode: 'nearest' | 'up' | 'down' = 'nearest',
): string {
  if (!Number.isFinite(px) || px <= 0) return '0';
  const tick = priceTick(px, szDecimals);
  const steps = px / tick;
  let stepped =
    mode === 'up'
      ? Math.ceil(steps - 1e-12) * tick
      : mode === 'down'
        ? Math.floor(steps + 1e-12) * tick
        : Math.round(steps) * tick;
  if (stepped <= 0) return '0';
  const maxDec = pxMaxDecimals(szDecimals);
  const f = 10 ** maxDec;
  stepped = Math.round(stepped * f) / f;
  if (stepped <= 0) return '0';
  return stepped.toFixed(maxDec).replace(/\.?0+$/, '') || '0';
}

async function szDecimalsFor(coin: string): Promise<number> {
  const meta = await getMeta();
  return meta.universe.find((a) => a.name === coin)?.szDecimals ?? 0;
}

export function roundSz(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  const rounded = Math.round(sz * f) / f;
  if (rounded <= 0) return '0';
  return rounded.toFixed(szDecimals).replace(/\.?0+$/, '') || '0';
}

export type OrderOutcome = {
  ok: boolean;
  error?: string;
  oid?: number;
  totalSz?: string;
  avgPx?: string;
  raw: unknown;
};

export function parseOrderResult(result: any): OrderOutcome {
  if (!result || result.status !== 'ok') {
    return { ok: false, error: JSON.stringify(result ?? 'empty result'), raw: result };
  }
  const st = result.response?.data?.statuses?.[0];
  if (!st) return { ok: false, error: 'no order status', raw: result };
  if (st.error) return { ok: false, error: String(st.error), raw: result };
  if (st.filled) {
    return {
      ok: true,
      oid: st.filled.oid,
      totalSz: String(st.filled.totalSz ?? ''),
      avgPx: st.filled.avgPx != null ? String(st.filled.avgPx) : undefined,
      raw: result,
    };
  }
  if (st.resting) {
    return { ok: true, oid: st.resting.oid, raw: result };
  }
  return { ok: false, error: JSON.stringify(st), raw: result };
}

export async function getSpotClearinghouse(wallet: string) {
  return infoRequest({ type: 'spotClearinghouseState', user: wallet });
}

export async function getSpotUsdc(wallet: string): Promise<number> {
  const data: any = await getSpotClearinghouse(wallet);
  const usdc = (data?.balances ?? []).find((b: any) => b.coin === 'USDC');
  if (!usdc) return 0;
  const total = parseFloat(usdc.total ?? '0') || 0;
  const hold = parseFloat(usdc.hold ?? '0') || 0;
  return Math.max(0, total - hold);
}

export async function getAccountValue(wallet: string): Promise<number> {
  const data: any = await getAccountSummary(wallet);
  const perp = parseFloat(data?.marginSummary?.accountValue ?? '0') || 0;
  const spot = await getSpotUsdc(wallet);
  // Unified / spot-collateral accounts report 0 on perps and the real USDC on spot
  return Math.max(perp, spot);
}

export async function getWithdrawable(wallet: string): Promise<number> {
  const data: any = await getAccountSummary(wallet);
  const perp = parseFloat(data?.withdrawable ?? data?.marginSummary?.withdrawable ?? '0') || 0;
  const spot = await getSpotUsdc(wallet);
  return Math.max(perp, spot);
}

export async function getOpenOrders(wallet: string) {
  return infoRequest({ type: 'openOrders', user: wallet });
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct = 0.02,
  reduceOnly = false,
) {
  const mids = await getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) throw new Error(`No mid price for ${coin} on ${getNetworkLabel()}`);

  const szDecimals = await szDecimalsFor(coin);
  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
  const limitPx = roundPx(rawPx, szDecimals, isBuy ? 'up' : 'down');
  if (parseFloat(limitPx) <= 0) {
    throw new Error(`Rounded limit price is 0 for ${coin} mid=${mid}`);
  }

  const order: Record<string, unknown> = {
    coin: toSdkCoin(coin),
    is_buy: isBuy,
    sz: parseFloat(size),
    limit_px: parseFloat(limitPx),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: reduceOnly,
    grouping: 'na',
  };
  // Builder fee is for Invo mainnet integration — skip on testnet
  if (!isHlTestnet()) order.builder = INVO_BUILDER;

  const s = getSdk();
  return s.exchange.placeOrder(order as any);
}

export async function placeTriggerOrder(opts: {
  coin: string;
  isBuy: boolean;
  size: string;
  triggerPx: number;
  tpsl: 'tp' | 'sl';
  reduceOnly?: boolean;
}) {
  const mids = await getAllMids();
  const mid = parseFloat(mids[opts.coin]);
  if (!mid) throw new Error(`No mid price for ${opts.coin} on ${getNetworkLabel()}`);

  const szDecimals = await szDecimalsFor(opts.coin);
  const triggerPx = parseFloat(roundPx(opts.triggerPx, szDecimals, 'nearest'));
  const slip = 0.02;
  const rawLimit = opts.isBuy ? triggerPx * (1 + slip) : triggerPx * (1 - slip);

  const order: Record<string, unknown> = {
    coin: toSdkCoin(opts.coin),
    is_buy: opts.isBuy,
    sz: parseFloat(opts.size),
    limit_px: parseFloat(roundPx(rawLimit, szDecimals, opts.isBuy ? 'up' : 'down')),
    order_type: {
      trigger: {
        triggerPx,
        isMarket: true,
        tpsl: opts.tpsl,
      },
    },
    reduce_only: opts.reduceOnly !== false,
    grouping: 'na',
  };
  if (!isHlTestnet()) order.builder = INVO_BUILDER;

  const s = getSdk();
  return s.exchange.placeOrder(order as any);
}

export async function cancelOid(coin: string, oid: number) {
  const s = getSdk();
  return s.exchange.cancelOrder({ coin: toSdkCoin(coin), o: oid });
}

export async function closePosition(coin: string, wallet: string) {
  const positions = await getPositions(wallet);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const size = Math.abs(parseFloat(pos.szi));
  const isLong = parseFloat(pos.szi) > 0;
  return placeMarketOrder(coin, !isLong, size.toString(), 0.02, true);
}

export { INVO_BUILDER };
