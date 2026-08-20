/**
 * Sync Following/Trending feed events into the same portfolio folders:
 *
 *   data/traders/{trader}/{portfolio}/feed-events.json
 *   data/traders/{trader}/{portfolio}/feed-events.csv
 *
 * Open/closed live positions are managed by fetch-live-opens.ts — not here.
 *
 * Usage:
 *   npx tsx src/commands/sync-traders.ts
 *   npx tsx src/commands/sync-traders.ts --watch
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';
import {
  parseFeedPost,
  mergeEvents,
  eventsToCsv,
  type TradeEvent,
} from '../lib/trade-events.js';
import { slug } from '../lib/slug.js';
import { writeFeedEvents, portfolioDir, TRADERS_ROOT } from '../lib/portfolio-store.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

const UNKNOWN = 'unknown';

async function fetchFeedSafe(filter: string, maxPages: number, pageSize: number): Promise<any[]> {
  try {
    return await invo.getFeedPages(filter, maxPages, pageSize);
  } catch (e: any) {
    console.error(`Feed "${filter}" skipped: ${e.message}`);
    return [];
  }
}

function collectEvents(posts: any[], now: string): TradeEvent[] {
  const events: TradeEvent[] = [];
  const seen = new Set<string>();
  for (const p of posts) {
    const e = parseFeedPost(p, now);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    events.push(e);
  }
  return events;
}

function collectFollowed(followingPosts: any[]): Set<string> {
  const ids = new Set<string>();
  for (const p of followingPosts) {
    const owner = p.update?.owner ?? p.owner;
    if (owner?.id) ids.add(owner.id);
    if (owner?.username) ids.add(owner.username);
  }
  return ids;
}

function isFollowed(e: TradeEvent, followed: Set<string>): boolean {
  if (e.traderId && followed.has(e.traderId)) return true;
  if (e.trader && followed.has(e.trader)) return true;
  return false;
}

async function runOnce() {
  const now = new Date().toISOString();
  console.error('Fetching feeds: following, trending...');
  const following = await fetchFeedSafe('following', 12, 50);
  const trending = await fetchFeedSafe('trending', 6, 50);
  const followed = collectFollowed(following);

  const followingEvents = collectEvents(following, now);
  const trendingEvents = collectEvents(trending, now).filter((e) => isFollowed(e, followed));

  const byId = new Map<string, TradeEvent>();
  for (const e of [...followingEvents, ...trendingEvents]) byId.set(e.id, e);
  const events = [...byId.values()];

  const byPortfolio = new Map<string, TradeEvent[]>();
  for (const e of events) {
    const key = `${slug(e.trader || UNKNOWN)}:::${slug(e.portfolioTitle || 'Main')}`;
    if (!byPortfolio.has(key)) byPortfolio.set(key, []);
    byPortfolio.get(key)!.push(e);
  }

  const report: any[] = [];
  for (const [, incoming] of byPortfolio) {
    const sample = incoming[0];
    const trader = sample.trader || UNKNOWN;
    const portfolioTitle = sample.portfolioTitle || 'Main';

    const existingPath = join(portfolioDir(trader, portfolioTitle), 'feed-events.json');
    let prev: TradeEvent[] = [];
    if (existsSync(existingPath)) {
      try {
        prev = JSON.parse(readFileSync(existingPath, 'utf8')).events ?? [];
      } catch {
        prev = [];
      }
    }
    const merged = mergeEvents(prev, incoming);
    writeFeedEvents(trader, portfolioTitle, sample.portfolioId, merged, eventsToCsv(merged));

    report.push({
      trader,
      portfolio: portfolioTitle,
      eventCount: merged.length,
      actions: merged.reduce(
        (acc, e) => {
          acc[e.action] = (acc[e.action] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    });
  }

  const tradersOnDisk = existsSync(TRADERS_ROOT)
    ? readdirSync(TRADERS_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  console.log(
    JSON.stringify(
      {
        syncedAt: now,
        root: TRADERS_ROOT,
        tradersOnDisk,
        updatedThisRun: report,
        note: 'Feed history only. Live opens/closes: npx tsx src/commands/fetch-live-opens.ts --watch',
      },
      null,
      2,
    ),
  );
}

async function main() {
  if (process.argv.includes('--watch')) {
    console.error('Watch mode: feed sync every 15s. Ctrl+C to stop.');
    for (;;) {
      try {
        await runOnce();
      } catch (e: any) {
        console.error('[watch error]', e.message);
      }
      await new Promise((r) => setTimeout(r, 15000));
    }
  } else {
    await runOnce();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
