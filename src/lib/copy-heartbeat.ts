/**
 * Copy-bot liveness file for the watchdog (watch-copy-bot.ts).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { COPY_DIR } from './copy-state.js';

export type CopyBotStatus = 'starting' | 'idle' | 'tick' | 'shutting_down';

export interface CopyBotHeartbeat {
  pid: number;
  startedAt: string;
  updatedAt: string;
  lastTickAt: string | null;
  lastSnapshot: string | null;
  openCopies: number;
  status: CopyBotStatus;
}

export const HEARTBEAT_PATH = join(COPY_DIR, 'copy-bot.heartbeat.json');

export function writeCopyHeartbeat(partial: Partial<CopyBotHeartbeat> & { status: CopyBotStatus }) {
  if (!existsSync(COPY_DIR)) mkdirSync(COPY_DIR, { recursive: true });

  let prev: CopyBotHeartbeat | null = null;
  if (existsSync(HEARTBEAT_PATH)) {
    try {
      prev = JSON.parse(readFileSync(HEARTBEAT_PATH, 'utf8'));
    } catch {
      prev = null;
    }
  }

  const now = new Date().toISOString();
  const hb: CopyBotHeartbeat = {
    pid: process.pid,
    startedAt: prev?.pid === process.pid ? prev.startedAt : now,
    updatedAt: now,
    lastTickAt: partial.lastTickAt ?? prev?.lastTickAt ?? null,
    lastSnapshot: partial.lastSnapshot ?? prev?.lastSnapshot ?? null,
    openCopies: partial.openCopies ?? prev?.openCopies ?? 0,
    status: partial.status,
  };
  writeFileSync(HEARTBEAT_PATH, JSON.stringify(hb, null, 2));
}

export function readCopyHeartbeat(): CopyBotHeartbeat | null {
  if (!existsSync(HEARTBEAT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(HEARTBEAT_PATH, 'utf8')) as CopyBotHeartbeat;
  } catch {
    return null;
  }
}

export function clearCopyHeartbeat() {
  if (!existsSync(HEARTBEAT_PATH)) return;
  try {
    unlinkSync(HEARTBEAT_PATH);
  } catch {
    /* ignore */
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}
