/**
 * Step 1: verify Hyperliquid testnet is set up correctly.
 * Does NOT place any trades — only reads account info.
 *
 * Usage (after filling .env):
 *   npx tsx src/commands/hl-setup-check.ts
 */
import { validateTradingEnv, HL_AGENT_KEY, WALLET_ADDRESS, HL_NETWORK, hlApiUrl } from '../env.js';
import * as hl from '../hl-client.js';

validateTradingEnv();

async function main() {
  console.log(`Network: ${HL_NETWORK} (${hlApiUrl()})`);
  console.log(`Wallet:  ${WALLET_ADDRESS.slice(0, 10)}...`);

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);
  console.log('SDK connect: OK');

  const summary: any = await hl.getAccountSummary(WALLET_ADDRESS);
  const margin = summary?.marginSummary ?? {};
  const spotUsdc = await hl.getSpotUsdc(WALLET_ADDRESS);
  const positions = await hl.getPositions(WALLET_ADDRESS);
  const perpVal = parseFloat(margin.accountValue ?? '0') || 0;
  const equity = Math.max(perpVal, spotUsdc);

  console.log(
    JSON.stringify(
      {
        ok: true,
        network: hl.getNetworkLabel(),
        accountValue: equity,
        perpAccountValue: margin.accountValue ?? null,
        spotUsdc,
        withdrawable: summary?.withdrawable ?? margin.withdrawable ?? null,
        openPositions: positions.length,
        positions: positions.map((p: any) => ({
          coin: p.coin,
          size: p.szi,
          entry: p.entryPx,
        })),
        nextStep:
          equity > 0
            ? 'Step 2: run a tiny test trade — npx tsx src/commands/trade.ts SOL long 0.01 2'
            : 'Get test USDC: https://app.hyperliquid-testnet.xyz/drip then run this again',
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  console.error('');
  console.error('Checklist:');
  console.error('  1. HL_NETWORK=testnet in .env');
  console.error('  2. WALLET_ADDRESS = your testnet wallet (0x...)');
  console.error('  3. HL_AGENT_KEY = API wallet private key from testnet app');
  console.error('  4. Claim USDC: https://app.hyperliquid-testnet.xyz/drip');
  process.exit(1);
});
