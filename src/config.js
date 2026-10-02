// Configuration comes from the environment (.env.local, then .env). Secrets never live in code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env.local', '.env']) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  try {
    process.loadEnvFile(p); // never overrides variables that are already set
  } catch (err) {
    console.warn(`Could not read ${file}: ${err.message}`);
  }
}

const env = (key, fallback = '') => String(process.env[key] ?? fallback).trim();
const int = (key, fallback) => {
  const n = Number.parseInt(env(key, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const port = int('PORT', 3000);

export const config = {
  port,
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  clio: {
    baseUrl: env('CLIO_BASE_URL', 'https://app.clio.com').replace(/\/+$/, ''),
    accessToken: env('CLIO_ACCESS_TOKEN'),
    clientId: env('CLIO_CLIENT_ID'),
    clientSecret: env('CLIO_CLIENT_SECRET'),
    redirectUri: env('CLIO_REDIRECT_URI', `http://localhost:${port}/clio/callback`),
    matterId: env('CLIO_MATTER_ID'),
    matterQuery: env('CLIO_MATTER_QUERY'),
  },
  ai: {
    apiKey: env('ANTHROPIC_API_KEY'),
    baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''),
    extractModel: env('EXTRACT_MODEL', 'claude-haiku-4-5-20251001'),
    synthModel: env('SYNTH_MODEL', 'claude-sonnet-5-5'),
    concurrency: int('AI_CONCURRENCY', 4),
    // Safety valve for very large scans. Pages beyond this are reported as unread, never silently dropped.
    maxDocPages: int('MAX_DOC_PAGES', 200),
    // Upper bound on the fact ledger sent to the brief writer, in characters (about four per token).
    // New API accounts have a small per-minute input allowance. Raise this on a higher tier.
    ledgerChars: int('LEDGER_CHARS', 64000),
  },
  share: {
    linkDays: int('SHARE_LINK_DAYS', 14),
  },
};

export const aiConfigured = () => Boolean(config.ai.apiKey);
