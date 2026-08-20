import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { slug } from './slug.js';

export interface CopyPortfolioRef {
  trader: string;
  portfolio: string;
}

export interface CopyConfig {
  portfolios: CopyPortfolioRef[];
  network: 'testnet' | 'mainnet';
  marginMode: 'isolated' | 'cross';
  minNotionalUsd: number;
  pollIntervalSec: number;
}

const DEFAULTS: CopyConfig = {
  portfolios: [],
  network: 'testnet',
  marginMode: 'isolated',
  minNotionalUsd: 10,
  pollIntervalSec: 15,
};

export function configPath(): string {
  return join(process.cwd(), 'copy-config.json');
}

export function loadCopyConfig(): CopyConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`Missing ${path} — copy-config.json is required`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const cfg: CopyConfig = {
    ...DEFAULTS,
    ...raw,
    portfolios: Array.isArray(raw.portfolios) ? raw.portfolios : [],
  };
  if (cfg.portfolios.length === 0) {
    throw new Error('copy-config.json has no portfolios');
  }
  for (const p of cfg.portfolios) {
    if (!p?.trader || !p?.portfolio) {
      throw new Error('Each portfolio entry needs trader and portfolio');
    }
  }
  return cfg;
}

export function isConfiguredPortfolio(cfg: CopyConfig, trader: string, portfolioTitle: string): boolean {
  const t = slug(trader);
  const p = slug(portfolioTitle);
  return cfg.portfolios.some((x) => slug(x.trader) === t && slug(x.portfolio) === p);
}

export function configuredTraders(cfg: CopyConfig): string[] {
  return [...new Set(cfg.portfolios.map((p) => p.trader))];
}
