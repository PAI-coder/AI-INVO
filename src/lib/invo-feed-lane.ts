/**
 * Fast lane until Invo WebSocket URL is known: poll Following feed every N seconds.
 * Triggers a full REST sync when a new verified trade post appears.
 */
import * as invo from '../invo-client.js';

export interface FeedLaneOptions {
  intervalSec?: number;
  followedUsernames?: Set<string>;
  onSignal: (info: { source: 'feed-fast'; trader: string; coin: string; action: string }) => void;
  onStatus?: (msg: string) => void;
}

function tradeAction(update: any): string {
  const isOpen = update?.isOpen === true;
  const isClosed = update?.isOpen === false && update?.closingPrice != null;
  if (isClosed) return 'close';
  if (update?.changes?.isAdded !== false && isOpen) return 'open';
  if (isOpen) return 'increase';
  return 'update';
}

export function startFeedFastLane(opts: FeedLaneOptions): { stop: () => void } {
  const intervalMs = (opts.intervalSec ?? 5) * 1000;
  const seenPosts = new Set<string>();
  let firstPoll = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const log = (msg: string) => opts.onStatus?.(msg);

  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const data = await invo.getFeed('following', null, 25);
      const posts = data.items ?? [];
      for (const post of posts) {
        if (seenPosts.has(post.id)) continue;
        seenPosts.add(post.id);
        if (firstPoll) continue;

        const update = post.update;
        if (!update?.ticker) continue;
        if (!update.verifiedTrade) continue;

        const username = update.owner?.username ?? post.owner?.username ?? '';
        if (opts.followedUsernames && opts.followedUsernames.size > 0) {
          if (!opts.followedUsernames.has(username)) continue;
        }

        const action = tradeAction(update);
        log(`feed signal: ${username} ${update.ticker} ${action}`);
        opts.onSignal({
          source: 'feed-fast',
          trader: username,
          coin: update.ticker,
          action,
        });
      }
      if (firstPoll) {
        firstPoll = false;
        log(`indexed ${seenPosts.size} existing feed posts`);
      }
    } catch (e: unknown) {
      log(`feed poll error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  };

  void poll();
  timer = setInterval(poll, intervalMs);
  log(`feed fast lane every ${opts.intervalSec ?? 5}s`);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
