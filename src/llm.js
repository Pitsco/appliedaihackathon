// One door to the model. Every call is forced to answer through a JSON tool, is retried
// politely when the API is busy, and is logged with its token usage and cost so the
// per-case cost on screen is measured, not estimated.
import { config } from './config.js';
import { run, now } from './db.js';
import { sleep } from './util.js';
import { costOf } from './pricing.js';

export class LlmError extends Error {
  constructor(message, { status = null, kind = 'http' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.kind = kind; // 'auth' | 'truncated' | 'invalid' | 'http'
  }
}

let context = { runId: null, matterId: null };
export const setLlmContext = (next) => {
  context = { ...context, ...next };
};

// A small semaphore keeps us inside the account's rate limit however the pipeline fans out.
let active = 0;
const waiting = [];
const acquire = async () => {
  if (active >= config.ai.concurrency) await new Promise((resolve) => waiting.push(resolve));
  active++;
};
const release = () => {
  active--;
  waiting.shift()?.();
};

// When the API says "slow down", every worker waits, not just the one that was told.
let pausedUntil = 0;
const backoff = (attempt) => Math.min(60_000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 800);

function record({ step, model, usage, started, ok, error }) {
  const input = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  const output = usage?.output_tokens || 0;
  run(
    'INSERT INTO llm_calls (run_id, matter_id, step, model, input_tokens, output_tokens, cost_usd, duration_ms, ok, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    context.runId, context.matterId, step, model, input, output, costOf(model, input, output), Date.now() - started, ok ? 1 : 0, error || null, now(),
  );
}

/**
 * Ask the model to fill in `tool.input_schema`. Returns the parsed object.
 * `content` is the user turn: a string, or an array of content blocks (text, document, image).
 */
export async function callTool({ step, model, system, content, tool, maxTokens = 8000 }) {
  await acquire();
  const started = Date.now();
  try {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    });
    let last = null;
    for (let attempt = 0; attempt < 7; attempt++) {
      const pause = pausedUntil - Date.now();
      if (pause > 0) await sleep(pause);
      let res;
      try {
        res = await fetch(`${config.ai.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(285_000),
        });
      } catch (err) {
        last = new LlmError(`Could not reach the AI service (${err.cause?.code || err.name}).`);
        await sleep(backoff(attempt));
        continue;
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 90) * 1000 + 500 : backoff(attempt);
        pausedUntil = Math.max(pausedUntil, Date.now() + wait);
        last = new LlmError(res.status === 429 ? 'The AI service is rate limiting this key.' : `The AI service is busy (${res.status}).`, { status: res.status });
        await res.arrayBuffer().catch(() => {});
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const message = json?.error?.message || `HTTP ${res.status}`;
        record({ step, model, usage: null, started, ok: false, error: message });
        throw new LlmError(
          res.status === 401 || res.status === 403 ? `The AI key was rejected: ${message}` : res.status === 404 ? `The AI service does not know the model "${model}": ${message}` : `The AI service refused the request: ${message}`,
          { status: res.status, kind: [401, 403].includes(res.status) ? 'auth' : res.status === 404 ? 'auth' : 'http' },
        );
      }
      const block = (json?.content || []).find((b) => b.type === 'tool_use');
      const truncated = json?.stop_reason === 'max_tokens';
      const valid = block && block.input && typeof block.input === 'object';
      record({ step, model, usage: json?.usage, started, ok: valid && !truncated, error: truncated ? 'max_tokens' : valid ? null : 'no structured output' });
      if (truncated) throw new LlmError('The model ran out of room before it finished.', { kind: 'truncated' });
      if (!valid) throw new LlmError('The model did not return structured output.', { kind: 'invalid' });
      return block.input;
    }
    record({ step, model, usage: null, started, ok: false, error: last?.message || 'gave up' });
    throw last || new LlmError('The AI service did not answer.');
  } finally {
    release();
  }
}
