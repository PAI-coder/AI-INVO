/**
 * Test an Invo WebSocket URL (capture from DevTools → Network → WS).
 *
 * Usage:
 *   npx tsx src/commands/probe-ws.ts wss://...
 *   INVO_WS_URL=wss://... npx tsx src/commands/probe-ws.ts
 */
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, INVO_WS_URL } from '../env.js';
import * as invo from '../invo-client.js';
import { startInvoWebSocket } from '../lib/invo-ws.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

const url = process.argv[2] || INVO_WS_URL;
if (!url) {
  console.error('Usage: npx tsx src/commands/probe-ws.ts <wss-url>');
  console.error('Or set INVO_WS_URL in .env');
  console.error('');
  console.error('How to find the URL:');
  console.error('  1. Open https://app.invoapp.com (logged in)');
  console.error('  2. DevTools → Network → filter WS');
  console.error('  3. Use the site for ~30s, copy the wss:// URL');
  process.exit(1);
}

console.error(`Probing ${url} for 60s — watch for [ws] lines…`);

const ws = startInvoWebSocket({
  url,
  getToken: async () => {
    await invo.ensureToken();
    return invo.getAccessToken();
  },
  onSignal: (info) => console.log(JSON.stringify({ type: 'signal', ...info })),
  onStatus: (msg) => console.error(`[ws] ${msg}`),
});

setTimeout(() => {
  ws.stop();
  console.error('[ws] probe finished');
  process.exit(0);
}, 60_000);
