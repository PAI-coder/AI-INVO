import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const COPY_DIR = join(process.cwd(), 'data', 'copy');
export const STATE_PATH = join(COPY_DIR, 'state.json');

export type CopyStatus = 'open' | 'closed' | 'skipped' | 'dead';

export interface CopyRecord {
  baseId: string;
  trader: string;
  portfolio: string;
  coin: string;
  direction: 'long' | 'short';
  leverage: number;
  entrySize: number;
  hlSize: number;
  /** Average HL fill price for this copy. Kept across bot restarts. */
  hlEntryPrice: number | null;
  tpOid: number | null;
  slOid: number | null;
  priceTarget: number | null;
  stopLoss: number | null;
  status: CopyStatus;
  skipReason?: string;
  openedAt?: string;
  updatedAt: string;
}

export interface CopyState {
  baselinedAt: string | null;
  ignoredBaseIds: string[];
  alertedPortfolios: string[];
  warnedForeignCoins: string[];
  copies: Record<string, CopyRecord>;
}

function emptyState(): CopyState {
  return {
    baselinedAt: null,
    ignoredBaseIds: [],
    alertedPortfolios: [],
    warnedForeignCoins: [],
    copies: {},
  };
}

export function ensureCopyDir() {
  if (!existsSync(COPY_DIR)) mkdirSync(COPY_DIR, { recursive: true });
}

export function loadCopyState(): CopyState {
  ensureCopyDir();
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      ...emptyState(),
      ...raw,
      ignoredBaseIds: raw.ignoredBaseIds ?? [],
      alertedPortfolios: raw.alertedPortfolios ?? [],
      warnedForeignCoins: raw.warnedForeignCoins ?? [],
      copies: raw.copies ?? {},
    };
  } catch {
    return emptyState();
  }
}

export function saveCopyState(state: CopyState) {
  ensureCopyDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function openCopies(state: CopyState): CopyRecord[] {
  return Object.values(state.copies).filter((c) => c.status === 'open');
}
