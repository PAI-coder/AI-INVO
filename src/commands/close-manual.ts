/**
 * One-shot: close ALL open HL positions and wipe bot state clean.
 * Usage: npx tsx src/commands/close-manual.ts
 */
import { validateHlEnv, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as hl from '../hl-client.js';
import { loadCopyConfig } from '../lib/copy-config.js';
import { loadCopyState, saveCopyState } from '../lib/copy-state.js';
import { listOpenPositions } from '../lib/portfolio-store.js';

validateHlEnv();

async function main() {
  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS, { enableWs: false });

  // Get all open positions on HL
  const positions = await hl.getPositions(WALLET_ADDRESS);
  const open = positions.filter((p: any) => parseFloat(p.szi) !== 0);

  if (open.length === 0) {
    console.error('No open positions on HL.');
  } else {
    console.error(`Closing ${open.length} open position(s) on HL...`);
    for (const pos of open) {
      const coin = String(pos.coin).replace(/-PERP$/i, '');
      const size = Math.abs(parseFloat(pos.szi));
      const isLong = parseFloat(pos.szi) > 0;
      try {
        const result = await hl.placeMarketOrder(coin, !isLong, size.toString(), 0.02, true);
        const parsed = hl.parseOrderResult(result);
        if (parsed.ok) {
          console.error(`  closed ${coin} avgPx=${parsed.avgPx ?? '?'} sz=${parsed.totalSz ?? '?'}`);
        } else {
          console.error(`  ${coin}: close failed — ${parsed.error}`);
        }
      } catch (e: any) {
        console.error(`  ${coin}: error — ${e.message ?? e}`);
      }
    }
  }

  // Mark open/skipped copies dead and ignore all current Invo opens
  const cfg = loadCopyConfig();
  const state = loadCopyState();
  const ignored = new Set(state.ignoredBaseIds);
  for (const p of cfg.portfolios) {
    for (const row of listOpenPositions(p.trader, p.portfolio)) {
      if (row.baseId) ignored.add(row.baseId);
    }
  }
  state.ignoredBaseIds = [...ignored];

  let wiped = 0;
  for (const copy of Object.values(state.copies)) {
    if (copy.status === 'open' || copy.status === 'skipped') {
      copy.status = 'dead';
      copy.updatedAt = new Date().toISOString();
      wiped++;
    }
  }
  state.baselinedAt = new Date().toISOString();
  saveCopyState(state);
  console.error(`\nState: closed HL positions, marked ${wiped} copies dead, ignoring ${ignored.size} Invo open(s).`);
  console.error('Done. Restart copy-bot — only NEW trades after this will be copied.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
