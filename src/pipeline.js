// The sync: pull from Clio, read what is new, rewrite the brief. Runs in the background;
// the pages poll its progress. Nothing here is specific to one matter.
import { aiConfigured } from './config.js';
import { all, get, run, now, getSetting } from './db.js';
import { pullMatter } from './pull.js';
import { pendingTextItems, pendingDocuments, digestTextItems, digestDocument, matterContext } from './extract.js';
import { synthesize } from './synthesize.js';
import { setLlmContext, LlmError } from './llm.js';
import { truncate } from './util.js';

const state = (globalThis.__casebriefSync ??= {
  running: false,
  phase: 'idle',
  message: '',
  done: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  warnings: [],
});

export function runTotals(runId) {
  const t = get('SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, SUM(cost_usd) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced FROM llm_calls WHERE run_id = ?', runId);
  return { calls: t.calls, input_tokens: t.input, output_tokens: t.output, cost_usd: t.cost, unpriced: t.unpriced };
}

export function syncStatus() {
  const last = get('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
  return { ...state, lastRun: last ? { id: last.id, status: last.status, started_at: last.started_at, finished_at: last.finished_at, error: last.error, totals: runTotals(last.id) } : null };
}

const phase = (name, message) => {
  state.phase = name;
  state.message = message;
};

export function startSync(options = {}) {
  if (state.running) return false;
  Object.assign(state, { running: true, phase: 'starting', message: 'Starting', done: 0, total: 0, startedAt: now(), finishedAt: null, error: null, warnings: [] });
  runSync(options)
    .catch((err) => {
      state.error = err.message;
      console.error('Sync failed:', err.message);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = now();
      if (state.phase !== 'error') phase(state.error ? 'error' : 'done', state.error || state.message);
    });
  return true;
}

export async function runSync({ rebuild = false, pullOnly = false } = {}) {
  const runId = Number(run('INSERT INTO runs (started_at, status) VALUES (?, ?)', now(), 'running').lastInsertRowid);
  setLlmContext({ runId, matterId: getSetting('matter_id') });
  const finish = (status, error = null, stats = {}) =>
    run('UPDATE runs SET finished_at = ?, status = ?, error = ?, stats = ? WHERE id = ?', now(), status, error, JSON.stringify(stats), runId);

  try {
    phase('pull', 'Connecting to Clio');
    const pulled = await pullMatter({ onProgress: (message) => (state.message = message) });
    const matterId = pulled.matterId;
    state.warnings = pulled.warnings;
    setLlmContext({ runId, matterId });
    run('UPDATE runs SET matter_id = ? WHERE id = ?', matterId, runId);

    if (pullOnly || !aiConfigured()) {
      phase('done', aiConfigured() ? 'Pulled from Clio' : 'Pulled from Clio. Add ANTHROPIC_API_KEY to digest it.');
      finish('done', null, { counts: pulled.counts, digested: 0 });
      return;
    }

    if (rebuild) run("UPDATE source_items SET digested_hash = NULL WHERE matter_id = ? AND kind NOT IN ('matter','field','contact')", matterId);

    const entries = pendingTextItems(matterId);
    const documents = pendingDocuments(matterId);
    state.total = entries.length + documents.length;
    state.done = 0;

    if (entries.length) {
      phase('read', `Reading ${entries.length} notes, emails, tasks and expenses`);
      await digestTextItems(matterId, entries, () => state.done++);
    }

    const hadBrief = Boolean(get('SELECT 1 AS x FROM briefs WHERE matter_id = ?', matterId));
    if (!hadBrief && entries.length && documents.length) {
      // Put a first brief on screen from the notes and emails while the documents are still being read.
      phase('brief', 'Writing a first brief while the documents are read');
      try {
        await synthesize(matterId, { partial: true });
      } catch (err) {
        if (err instanceof LlmError && err.kind === 'auth') throw err;
        state.warnings.push(`First brief: ${err.message}`);
      }
    }

    if (documents.length) {
      const ctx = matterContext(matterId);
      let read = 0;
      phase('documents', `Reading documents 0/${documents.length}`);
      await Promise.all(
        documents.map(async (doc) => {
          try {
            await digestDocument(matterId, doc, ctx);
          } catch (err) {
            if (err instanceof LlmError && err.kind === 'auth') throw err;
            run('UPDATE source_items SET digest_error = ? WHERE id = ?', truncate(err.message, 300), doc.id);
          }
          state.done++;
          phase('documents', `Reading documents ${++read}/${documents.length}`);
        }),
      );
    }

    const brief = get('SELECT partial FROM briefs WHERE matter_id = ?', matterId);
    const changed = entries.length + documents.length > 0;
    if (changed || !brief || brief.partial || rebuild) {
      phase('brief', 'Writing the brief');
      await synthesize(matterId, { partial: false });
    }

    const failed = all("SELECT COUNT(*) AS n FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND digest_error IS NOT NULL", matterId)[0].n;
    phase('done', changed ? `Read ${entries.length + documents.length} new or changed items` : 'Nothing new in Clio since the last sync');
    finish('done', null, { counts: pulled.counts, digested: entries.length + documents.length, failed, ...runTotals(runId) });
  } catch (err) {
    phase('error', err.message);
    state.error = err.message;
    finish('error', truncate(err.message, 500), runTotals(runId));
    throw err;
  }
}
