/**
 * Only one process may poll the Invo REST API at a time.
 * Copy-bot and fetcher share this lock so they cannot double-fetch.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export type PollOwner = 'fetcher' | 'copy-bot';

export interface PollLock {
  owner: PollOwner;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

const LOCK_PATH = join(process.cwd(), 'data', 'invo-poll.lock');
const STALE_MS = 120_000;

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // Windows: EPERM means the process exists but we cannot signal it
    return e?.code === 'EPERM';
  }
}

function readLock(): PollLock | null {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as PollLock;
  } catch {
    return null;
  }
}

function isStale(lock: PollLock): boolean {
  if (lock.pid === process.pid) return false;
  if (pidAlive(lock.pid)) return false;
  const age = Date.now() - Date.parse(lock.updatedAt || lock.startedAt || '');
  if (!Number.isFinite(age) || age > STALE_MS) return true;
  return true;
}

export function peekInvoPollLock(): PollLock | null {
  const lock = readLock();
  if (!lock) return null;
  if (isStale(lock)) return null;
  return lock;
}

export function acquireInvoPollLock(owner: PollOwner): { ok: true; lock: PollLock } | { ok: false; heldBy: PollLock } {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readLock();
  if (existing && !isStale(existing) && existing.pid !== process.pid) {
    return { ok: false, heldBy: existing };
  }

  const now = new Date().toISOString();
  const lock: PollLock = {
    owner,
    pid: process.pid,
    startedAt: existing?.pid === process.pid ? existing.startedAt : now,
    updatedAt: now,
  };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
  return { ok: true, lock };
}

export function touchInvoPollLock(owner: PollOwner) {
  const existing = readLock();
  if (!existing || existing.pid !== process.pid) return;
  existing.owner = owner;
  existing.updatedAt = new Date().toISOString();
  writeFileSync(LOCK_PATH, JSON.stringify(existing, null, 2));
}

export function releaseInvoPollLock() {
  const existing = readLock();
  if (!existing) return;
  if (existing.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}
