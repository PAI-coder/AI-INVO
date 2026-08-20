/**
 * Watchdog — checks copy-bot health and alerts if it dies or hangs.
 *
 * Run in a third terminal (keep open 24/7):
 *   npx tsx src/commands/watch-copy-bot.ts
 *
 * Requires fetcher + copy-bot heartbeat file from copy-bot.ts.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { alert, ensureCopyLogs } from '../lib/copy-log.js';
import { readCopyHeartbeat, pidAlive } from '../lib/copy-heartbeat.js';
import { peekInvoPollLock } from '../lib/invo-poll-lock.js';

const SUMMARY_PATH = join(process.cwd(), 'data', 'summary.json');
const CHECK_MS = 30_000;
/** No heartbeat this long while fetcher is live → bot dead or hung. */
const STALE_MS = 120_000;
const ALERT_DEBOUNCE_MS = 300_000;
/** Don't alert right after watchdog starts — lets you start copy-bot first. */
const WATCHDOG_STARTUP_GRACE_MS = 90_000;

function readSummaryAgeMs(): number | null {
  if (!existsSync(SUMMARY_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
    const t = Date.parse(data.fetchedAt ?? '');
    if (!Number.isFinite(t)) return null;
    return Date.now() - t;
  } catch {
    return null;
  }
}

function fetcherLooksAlive(): boolean {
  const lock = peekInvoPollLock();
  if (lock?.owner === 'fetcher' && pidAlive(lock.pid)) return true;
  const age = readSummaryAgeMs();
  return age != null && age < 90_000;
}

async function main() {
  ensureCopyLogs();
  console.error('[watch] copy-bot watchdog started — checking every 30s');
  console.error('[watch] startup grace 90s — start copy-bot now if not already running');

  const watchStartedAt = Date.now();
  let lastAlertAt = 0;

  const tick = () => {
    const hb = readCopyHeartbeat();
    const fetcherUp = fetcherLooksAlive();
    const summaryAge = readSummaryAgeMs();

    if (!fetcherUp) {
      console.error(
        `[watch] fetcher quiet (summary age=${summaryAge == null ? 'n/a' : `${Math.round(summaryAge / 1000)}s`}) — skipping copy-bot check`,
      );
      return;
    }

    const now = Date.now();
    if (now - watchStartedAt < WATCHDOG_STARTUP_GRACE_MS) {
      if (hb && pidAlive(hb.pid)) {
        console.error(
          `[watch] ok pid=${hb.pid} status=${hb.status} (startup grace, bot found)`,
        );
      } else {
        console.error('[watch] startup grace — waiting for copy-bot heartbeat');
      }
      return;
    }

    const hbAge = hb ? now - Date.parse(hb.updatedAt) : Infinity;
    const pidOk = hb ? pidAlive(hb.pid) : false;
    const stale = !hb || hbAge > STALE_MS || !pidOk;

    if (!stale) {
      console.error(
        `[watch] ok pid=${hb!.pid} status=${hb!.status} hbAge=${Math.round(hbAge / 1000)}s copies=${hb!.openCopies}`,
      );
      return;
    }

    const reason = !hb
      ? 'no heartbeat file'
      : !pidOk
        ? `pid ${hb.pid} not running`
        : `heartbeat stale ${Math.round(hbAge / 1000)}s`;

    if (now - lastAlertAt > ALERT_DEBOUNCE_MS) {
      lastAlertAt = now;
      alert(`WATCHDOG: copy-bot ${reason} — please restart it manually (fetcher is live)`);
    }
    console.error(`[watch] copy-bot problem detected: ${reason}`);
  };

  tick();
  setInterval(tick, CHECK_MS);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
