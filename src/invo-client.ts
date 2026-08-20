const BASE = 'https://api.invoapp.com';

let token = '';
let refreshToken = '';

export function setToken(t: string) {
  token = t.startsWith('Bearer ') ? t : `Bearer ${t}`;
}

export function setRefreshToken(t: string) {
  refreshToken = t;
}

/** Current Bearer access token (call ensureToken() first). */
export function getAccessToken(): string {
  return token;
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const resp = await fetch(`${BASE}/v1_0/auth/refresh_token`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'x-app-version': '0.0.75',
        'x-platform': 'web',
      },
    });
    if (resp.status !== 200) return false;
    const data = await resp.json();
    if (data.accessToken) {
      token = `Bearer ${data.accessToken}`;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Ensure we have a valid access token, refreshing if needed. */
export async function ensureToken(): Promise<void> {
  // If we have a token, check if it's about to expire
  if (token) {
    try {
      const payload = JSON.parse(atob(token.replace('Bearer ', '').split('.')[1]));
      const remainingSec = payload.expires - Date.now() / 1000;
      if (remainingSec > 30) return; // still valid
    } catch { /* can't decode — try refresh */ }
  }
  // Token missing or expiring soon — refresh
  const ok = await refreshAccessToken();
  if (!ok && !token) throw new Error('No valid Invo token and refresh failed');
}

async function post(path: string, body: any, retried = false): Promise<any> {
  await ensureToken();
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'x-app-version': '0.0.75',
      'x-platform': 'web',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // Some Invo responses are base64-encoded JSON
    try { data = JSON.parse(atob(text)); } catch { data = text; }
  }
  // Auto-retry on 401 with refreshed token
  if (resp.status === 401 && !retried) {
    const ok = await refreshAccessToken();
    if (ok) return post(path, body, true);
  }
  if (resp.status >= 400) {
    throw new Error(`Invo ${path} ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/** Exposed for API probing / extensions */
export async function rawPost(path: string, body: any): Promise<{ status: number; data: any }> {
  await ensureToken();
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'x-app-version': '0.0.75',
      'x-platform': 'web',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    try { data = JSON.parse(atob(text)); } catch { data = text; }
  }
  return { status: resp.status, data };
}

async function get(path: string, retried = false): Promise<any> {
  await ensureToken();
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: token },
  });
  if (resp.status === 401 && !retried) {
    const ok = await refreshAccessToken();
    if (ok) return get(path, true);
  }
  return resp.json();
}

// --- Discovery ---

export async function discoverTraders(filter: string, page = 1, size = 50, userId?: string) {
  const body: any = { filter, params: { page, size } };
  if (userId) body.userId = userId;
  return post('/v1_0/trending/get_portfolios_pl', body);
}

export async function getTrendingUsers(page = 1, size = 25) {
  return post('/v1_0/trending/get_users', { filter: 'trending', params: { page, size } });
}

export async function getFeed(filter: string, lastPostId: string | null = null, itemLimit = 50) {
  return post('/v1_0/posts/get_feed', {
    filter: { filter, assetTypes: [] },
    params: { lastPostId, itemLimit },
  });
}

export async function getFeedPages(filter: string, maxPages = 8, pageSize = 50): Promise<any[]> {
  const all: any[] = [];
  let lastPostId: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const data = await getFeed(filter, lastPostId, pageSize);
    const items = data.items ?? [];
    if (items.length === 0) break;
    all.push(...items);
    lastPostId = items[items.length - 1].id;
    if (items.length < pageSize) break;
  }
  return all;
}

// --- Social ---

export async function followUser(userId: string) {
  return post('/v1_0/users/follow', { objectId: userId });
}

export async function unfollowUser(userId: string) {
  return post('/v1_0/users/unfollow', { objectId: userId });
}

// --- Trading ---

export async function getTradeUpdates(investments: { baseShortId: string; mimicStartedAt: string }[]) {
  return post('/dex/trade', { investments });
}

export async function checkAccountReady() {
  return post('/dex/account/ready', {});
}

export interface RecordOpenPayload {
  clientTxId: string;
  coin: string;
  assetIndex: number;
  entry: {
    side: 'long' | 'short';
    marginMode: 'isolated' | 'cross';
    leverage: number;
    tpPx: string | null;
    slPx: string | null;
  };
  submission: {
    hlOrder: any;
    nonceMs: number;
    hlResponse: any;
  };
  summary: {
    qtyBefore: string;
    qtyAfter: string;
    intendedLeverage: number;
  };
  mimicMeta: {
    portfolioId: string;
    creatorInvoUserId: string;
    initialSourcePaperUpdateId: string;
    sourcePaperTradeBaseId: string;
  };
}

export async function recordOpen(payload: RecordOpenPayload) {
  return post('/dex/position/create', payload);
}

export interface RecordClosePayload {
  clientTxId: string;
  baseShortId: string;
  assetIndex: number;
  submission: {
    hlOrder: any;
    nonceMs: number;
    hlResponse: any;
  };
  summary: {
    qtyBefore: string;
    qtyAfter: string;
  };
}

export async function recordClose(payload: RecordClosePayload) {
  return post('/dex/position/close', payload);
}

export async function getInvestmentStatus(investmentBaseId: string) {
  return get(`/investment/status/${investmentBaseId}`);
}

/** Live open positions for a portfolio (same as Invo portfolio page → Open tab). */
export async function getPortfolioInvestments(
  portfolioId: string,
  opts: { isOpen?: boolean; page?: number; size?: number } = {},
) {
  const { isOpen = true, page = 1, size = 50 } = opts;
  return post('/v1_0/investments/get_investments', {
    portfolioId,
    isOpen,
    params: { page, size },
  });
}

export async function getPortfolioById(portfolioId: string) {
  return post('/v1_0/portfolios/get_portfolio_by_id', { portfolioId });
}

/** All portfolios on a trader profile (same as profile → Portfolios tab). */
export async function getUserPortfolios(userId: string) {
  return post('/v1_0/portfolios/get_users_portfolios', {
    userId,
    params: { page: 1, size: 50 },
  });
}

/** People the logged-in account follows. */
export async function getFollowingUsers() {
  const tries: [string, Record<string, unknown>][] = [
    ['/v1_0/users/get_following', { params: { page: 1, size: 50 } }],
    ['/v1_0/users/get_follows', { params: { page: 1, size: 50 } }],
    ['/v1_0/users/get_following_users', { params: { page: 1, size: 50 } }],
    ['/v1_0/users/following', { params: { page: 1, size: 50 } }],
  ];
  for (const [path, body] of tries) {
    const { status, data } = await rawPost(path, body);
    const items = data?.items ?? data?.users ?? data?.data ?? [];
    if (status === 200 && Array.isArray(items) && items.length > 0) {
      return items;
    }
  }
  return [];
}
