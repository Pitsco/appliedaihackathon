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

// Which AI service to use. Either works: set ANTHROPIC_API_KEY or OPENAI_API_KEY (or AI_PROVIDER to force one).
// An OpenAI key pasted into ANTHROPIC_API_KEY by mistake is recognised by its shape and used as an OpenAI key.
const ai = (() => {
  const anthropicKey = env('ANTHROPIC_API_KEY');
  const openaiKey = env('OPENAI_API_KEY') || (anthropicKey && !anthropicKey.startsWith('sk-ant-') && anthropicKey.startsWith('sk-') ? anthropicKey : '');
  const realAnthropic = anthropicKey && anthropicKey !== openaiKey ? anthropicKey : '';
  const forced = env('AI_PROVIDER', '').toLowerCase();
  const provider = forced === 'openai' || forced === 'anthropic' ? forced : openaiKey && !realAnthropic ? 'openai' : 'anthropic';
  // A model name left over from the other provider is ignored rather than sent to a service that does not know it.
  const model = (name, fallback) => {
    const value = env(name, '');
    const foreign = provider === 'openai' ? value.startsWith('claude') : /^(gpt|o\d)/.test(value);
    return value && !foreign ? value : fallback;
  };
  return provider === 'openai'
    ? { provider, apiKey: openaiKey, baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com').replace(/\/+$/, ''), extractModel: model('EXTRACT_MODEL', 'gpt-4.1-mini'), synthModel: model('SYNTH_MODEL', 'gpt-4.1') }
    : { provider, apiKey: realAnthropic, baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''), extractModel: model('EXTRACT_MODEL', 'claude-haiku-4-5-20251001'), synthModel: model('SYNTH_MODEL', 'claude-sonnet-5-5') };
})();

export const config = {
  port,
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  clio: {
    baseUrl: env('CLIO_BASE_URL', 'https://app.clio.com').replace(/\/+$/, ''),
    accessToken: env('CLIO_ACCESS_TOKEN'),
    clientId: env('CLIO_CLIENT_ID'),
    clientSecret: env('CLIO_CLIENT_SECRET'),
    redirectUri: env('CLIO_REDIRECT_URI', `http://127.0.0.1:${port}/clio/callback`),
    matterId: env('CLIO_MATTER_ID'),
    matterQuery: env('CLIO_MATTER_QUERY'),
  },
  ai: {
    provider: ai.provider,
    apiKey: ai.apiKey,
    baseUrl: ai.baseUrl,
    extractModel: ai.extractModel,
    synthModel: ai.synthModel,
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
