/**
 * Invo WebSocket client (experimental — URL/protocol from DevTools capture).
 * On any trade-like message, calls onSignal so REST backup can refresh full opens.
 */
import { ensureToken } from '../invo-client.js';

export interface InvoWsOptions {
  url: string;
  /** Bearer access token; refreshed automatically when missing. */
  getToken: () => Promise<string>;
  onSignal: (info: { source: 'websocket'; hint: string }) => void;
  onStatus?: (msg: string) => void;
  reconnectMs?: number;
}

function walkForTradeHint(value: unknown, depth = 0): string | null {
  if (value == null || depth > 8) return null;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const ticker = o.ticker ?? o.coin;
    const hasTrade =
      (typeof ticker === 'string' && ticker.length > 0) &&
      (o.verifiedTrade === true || o.isOpen != null || o.entryPrice != null || o.postType != null);
    if (hasTrade) {
      const side = o.directionLong === true ? 'long' : o.directionLong === false ? 'short' : '?';
      return `${ticker} ${o.leverage ?? '?'}x ${side}`;
    }
    for (const v of Object.values(o)) {
      const found = walkForTradeHint(v, depth + 1);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = walkForTradeHint(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseMessage(raw: string): { hint: string | null; text: string } {
  let text = raw;
  try {
    const data = JSON.parse(raw);
    text = JSON.stringify(data).slice(0, 200);
    return { hint: walkForTradeHint(data), text };
  } catch {
    try {
      const data = JSON.parse(atob(raw));
      text = JSON.stringify(data).slice(0, 200);
      return { hint: walkForTradeHint(data), text };
    } catch {
      return { hint: null, text: raw.slice(0, 200) };
    }
  }
}

export function startInvoWebSocket(opts: InvoWsOptions): { stop: () => void } {
  const WebSocketImpl = globalThis.WebSocket as typeof WebSocket | undefined;
  if (!WebSocketImpl) {
    throw new Error('WebSocket not available in this Node.js version (need Node 22+)');
  }

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const reconnectMs = opts.reconnectMs ?? 5_000;

  const log = (msg: string) => opts.onStatus?.(msg);

  const connect = async () => {
    if (stopped) return;
    await ensureToken();
    const token = (await opts.getToken()).replace(/^Bearer\s+/i, '');

    // Common patterns: token in query or subprotocol
    const sep = opts.url.includes('?') ? '&' : '?';
    const urlWithAuth = `${opts.url}${sep}token=${encodeURIComponent(token)}`;

    log(`connecting ${opts.url}`);
    ws = new WebSocketImpl(urlWithAuth, [`Bearer.${token}`]);

    ws.addEventListener('open', () => {
      log('connected');
      // Harmless subscribe attempts if server expects a first message
      const tries = [
        { action: 'subscribe', channel: 'following' },
        { type: 'subscribe', filter: 'following' },
        { opcode: 'subscribe', topic: 'feed' },
      ];
      for (const msg of tries) {
        try {
          ws?.send(JSON.stringify(msg));
        } catch {
          /* ignore */
        }
      }
    });

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      const { hint, text } = parseMessage(raw);
      if (hint) {
        log(`signal: ${hint}`);
        opts.onSignal({ source: 'websocket', hint });
      } else {
        log(`message: ${text}`);
      }
    });

    ws.addEventListener('close', () => {
      log('disconnected — reconnecting…');
      ws = null;
      if (!stopped) reconnectTimer = setTimeout(connect, reconnectMs);
    });

    ws.addEventListener('error', () => {
      log('socket error');
    });
  };

  void connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    },
  };
}
