import 'dotenv/config';

export const INVO_TOKEN = process.env.INVO_TOKEN ?? '';
export const INVO_REFRESH_TOKEN = process.env.INVO_REFRESH_TOKEN ?? '';
/** Optional — capture from Invo DevTools → Network → WS. Enables true WebSocket fast lane. */
export const INVO_WS_URL = process.env.INVO_WS_URL ?? '';
export const HL_AGENT_KEY = process.env.HL_AGENT_KEY ?? '';
export const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? '';
/** `testnet` (fake money) or `mainnet` (real money). Default: testnet. */
export const HL_NETWORK = (process.env.HL_NETWORK ?? 'testnet').toLowerCase();

export function isHlTestnet(): boolean {
  return HL_NETWORK !== 'mainnet';
}

export function hlApiUrl(): string {
  return isHlTestnet()
    ? 'https://api.hyperliquid-testnet.xyz'
    : 'https://api.hyperliquid.xyz';
}

export function hlWsUrl(): string {
  return isHlTestnet()
    ? 'wss://api.hyperliquid-testnet.xyz/ws'
    : 'wss://api.hyperliquid.xyz/ws';
}

/** Invo API only (discover / follow / monitor / feed). No trading keys required. */
export function validateEnv() {
  if (!INVO_TOKEN && !INVO_REFRESH_TOKEN) {
    console.error('Missing .env var: INVO_TOKEN or INVO_REFRESH_TOKEN');
    console.error('Create .env with:');
    console.error('  INVO_REFRESH_TOKEN=eyJ...  (350-day TTL, preferred)');
    process.exit(1);
  }
}

/** Hyperliquid keys only (copy-bot reads Invo data from disk; fetcher owns Invo HTTP). */
export function validateHlEnv() {
  const missing: string[] = [];
  if (!HL_AGENT_KEY || HL_AGENT_KEY.includes('your-agent')) missing.push('HL_AGENT_KEY');
  if (!WALLET_ADDRESS || WALLET_ADDRESS.includes('your-wallet')) missing.push('WALLET_ADDRESS');
  if (missing.length) {
    console.error(`Missing .env vars for Hyperliquid: ${missing.join(', ')}`);
    console.error('  HL_AGENT_KEY=0x...');
    console.error('  WALLET_ADDRESS=0x...');
    process.exit(1);
  }
}

/** Full copy-trading (trade / close / HL connect). */
export function validateTradingEnv() {
  validateEnv();
  validateHlEnv();
}
