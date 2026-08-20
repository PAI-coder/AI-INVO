/**
 * Watch live open positions into:
 *
 *   data/traders/{trader}/{portfolio}/open/
 *   data/traders/{trader}/{portfolio}/closed/
 *   data/traders/{trader}/{portfolio}/open.csv
 *   data/traders/{trader}/{portfolio}/closed.csv
 *
 * Usage:
 *   npx tsx src/commands/fetch-live-opens.ts
 *   npx tsx src/commands/fetch-live-opens.ts --trader crypto_rocket
 *   npx tsx src/commands/fetch-live-opens.ts --watch
 */
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';
import { runOnce, startHybridWatch } from '../lib/invo-sync.js';
import { acquireInvoPollLock, releaseInvoPollLock } from '../lib/invo-poll-lock.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function main() {
  const traderFilter = process.argv.includes('--trader')
    ? process.argv[process.argv.indexOf('--trader') + 1]
    : undefined;
  const watch = process.argv.includes('--watch');
  const forceRefresh = process.argv.includes('--refresh');
  const wsOnly = process.argv.includes('--ws-only');
  const intervalSec = process.argv.includes('--interval')
    ? parseInt(process.argv[process.argv.indexOf('--interval') + 1], 10)
    : 15;

  const lock = acquireInvoPollLock('fetcher');
  if (!lock.ok) {
    console.error(
      `Invo polling is already running as ${lock.heldBy.owner} (pid ${lock.heldBy.pid}).`,
    );
    if (lock.heldBy.owner === 'copy-bot') {
      console.error('A stale copy-bot lock should not block the fetcher. Delete data/invo-poll.lock if this persists.');
    } else {
      console.error('Another fetcher is already running. Do not start a second one.');
    }
    process.exit(1);
  }

  const release = () => releaseInvoPollLock();
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(0);
  });
  process.on('exit', release);

  if (watch) {
    const handle = startHybridWatch({
      traderFilter,
      intervalSec,
      restOnly: !wsOnly,
      wsOnly,
      forceRefresh,
      lockOwner: 'fetcher',
    });
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        handle.stop();
        release();
        resolve();
      });
    });
    process.exit(0);
  }

  await runOnce(traderFilter, forceRefresh || true);
  release();
}

main().catch((e) => {
  releaseInvoPollLock();
  console.error(e.message || e);
  process.exit(1);
});
