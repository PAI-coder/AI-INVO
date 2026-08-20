import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { COPY_DIR, ensureCopyDir } from './copy-state.js';

const LOG_PATH = join(COPY_DIR, 'copy-log.csv');
const ALERT_PATH = join(COPY_DIR, 'alerts.log');

const HEADERS = [
  'timestamp',
  'action',
  'trader',
  'portfolio',
  'coin',
  'direction',
  'baseId',
  'entrySize',
  'leverage',
  'hlSize',
  'reason',
  'detail',
] as const;

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function ensureCopyLogs() {
  ensureCopyDir();
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, HEADERS.join(',') + '\n');
  }
}

export function copyLog(row: {
  action: string;
  trader?: string;
  portfolio?: string;
  coin?: string;
  direction?: string;
  baseId?: string;
  entrySize?: number | null;
  leverage?: number | null;
  hlSize?: number | null;
  reason?: string;
  detail?: string;
}) {
  ensureCopyLogs();
  const line = [
    new Date().toISOString(),
    row.action,
    row.trader,
    row.portfolio,
    row.coin,
    row.direction,
    row.baseId,
    row.entrySize,
    row.leverage,
    row.hlSize,
    row.reason,
    row.detail,
  ]
    .map(csvEscape)
    .join(',');
  appendFileSync(LOG_PATH, line + '\n');
}

export function alert(msg: string) {
  ensureCopyDir();
  const line = `${new Date().toISOString()} ${msg}`;
  console.error(`[alert] ${msg}`);
  appendFileSync(ALERT_PATH, line + '\n');
  copyLog({ action: 'alert', reason: msg });
}
