// Step 2 of the pipeline: turn each raw item into small, cited facts.
//
// The model never sees "the whole case". It reads a handful of entries (or one stretch of a
// document) at a time and records what each one establishes, with the exact passage that
// proves it. Results are stored per item, keyed by the item's content hash, so an item is
// only ever read again if it changes in Clio.
import fs from 'node:fs';
import { config } from './config.js';
import { all, get, run, tx, now, parseJson } from './db.js';
import { callTool, LlmError } from './llm.js';
import { roster, documentPath } from './pull.js';
import { subsetPdf } from './pdf.js';
import { squash, clamp, truncate, isoDate, today } from './util.js';

export const FACT_TYPES = ['incident', 'liability', 'coverage', 'payer', 'injury', 'procedure', 'treatment', 'bill', 'firm_expense', 'lien', 'valuation', 'wage_loss', 'negotiation', 'court', 'deadline', 'discovery', 'records', 'client_contact', 'expert', 'employment', 'prior_history', 'risk', 'other'];
export const CATEGORIES = ['liability', 'coverage', 'damages', 'medical', 'treatment', 'billing', 'lien', 'valuation', 'negotiation', 'litigation', 'discovery', 'client', 'records', 'deadline', 'admin'];
const SENSITIVITY = ['strategy', 'valuation', 'liability', 'medical', 'billing', 'administrative'];
const DOC_TYPES = ['medical_record', 'medical_bill', 'imaging_report', 'operative_report', 'pleading', 'discovery', 'correspondence', 'expert_report', 'insurance', 'authorization', 'retainer', 'photo_id', 'employment', 'lien', 'police_report', 'photograph', 'other'];

const THIN_PAGE = 150; // characters; below this a page is treated as a bare scan and read by vision
const TEXT_BATCH_ITEMS = 12;
const TEXT_BATCH_CHARS = 9000;
const DOC_CHUNK_CHARS = 36000;
const VISION_PAGES_PER_CALL = 12;

const SYSTEM = `You are a senior paralegal at a plaintiff personal-injury law firm. You read raw case-file material and record what it establishes, so that an attorney who has never seen the file can trust a one-page brief built from your records.

Rules:
- Record only what the material itself says. Never add outside knowledge, never guess, never compute new totals.
- Every fact needs a "quote": a short passage copied character for character from the material that proves it (at most 240 characters). If you cannot quote it, do not record it.
- One fact per distinct point. Prefer fewer, sharper facts to many vague ones. Routine acknowledgements and scheduling chatter usually yield no facts or one.
- "detail" is one self-contained sentence that a newcomer understands without opening the source. Name people and organisations, not "he" or "they".
- Dates are YYYY-MM-DD and must come from the material or its date header. Leave a relative date such as "DOI + 94" (days after the date of injury) in the detail text unless the material gives the calendar date.
- Amounts are plain dollar numbers with no symbols, copied from the material.
- When a fact concerns a person or organisation in the contact roster, set "contact_id" to that roster id.
- If the material itself points out a contradiction, a weakness, something missing or something nobody has done, record it as type "risk".

Fact types:
incident (how, when and where the injury event happened) · liability (who was at fault, accounts of the event, defences) · coverage (insurance or other money available to pay a recovery, policy limits, self-insurance, uninsured motorist cover) · payer (who has been paying for treatment: no-fault, health insurance, Medicaid, lien) · injury (a diagnosis or finding) · procedure (surgery or injection: status performed, recommended, scheduled or declined) · treatment (visits, frequency, discharge, gaps: status ongoing, discharged or paused) · bill (charges from a medical provider for treating the client) · firm_expense (a cost the law firm paid to run the case) · lien (a claim on the recovery) · valuation (what the case is worth) · wage_loss · negotiation (demands and offers) · court (filings, conferences, orders) · deadline (a legal time limit) · discovery · records (records or bills: status requested, received, partial, outstanding or produced) · client_contact (a conversation with the client) · expert (defence or plaintiff medical examinations and expert reports) · employment · prior_history (injuries or conditions from before the event) · risk · other.

Importance, 0 to 100, is how much an attorney picking up the file cold needs this entry:
90-100 changes a deadline, liability, coverage or what the case is worth; a demand, offer or valuation; a summary of where the case stands.
70-89 a new diagnosis, a surgery, the end of or a gap in treatment, a court order, an expert report, a newly found weakness.
40-69 records or bills arriving, discovery steps, substantive client updates.
0-39 scheduling, requests, acknowledgements, reminders.

Sensitivity says who may see a fact: strategy (firm's thinking, weaknesses, plans) · valuation (case value, offers, settlement authority) · liability · medical · billing · administrative.`;

const factSchema = (withPage) => ({
  type: 'object',
  properties: {
    type: { type: 'string', enum: FACT_TYPES },
    title: { type: 'string', description: 'Headline, at most 8 words, no full stop.' },
    detail: { type: 'string', description: 'One self-contained sentence.' },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD the fact happened or is due, or null.' },
    amount: { type: ['number', 'null'], description: 'Dollar amount stated in the material, or null.' },
    contact_id: { type: ['string', 'null'], description: 'Roster id of the person or organisation this fact is about, or null.' },
    status: { type: ['string', 'null'], description: 'One lowercase word where the fact type calls for it (performed, recommended, ongoing, discharged, requested, received, outstanding, filed ...), else null.' },
    quote: { type: 'string', description: 'Exact passage from the material that proves the fact, at most 240 characters.' },
    sensitivity: { type: 'string', enum: SENSITIVITY },
    ...(withPage ? { page: { type: 'integer', description: 'Page number of the original document the quote is on.' } } : {}),
  },
  required: ['type', 'title', 'detail', 'quote', 'sensitivity', ...(withPage ? ['page'] : [])],
});

const entryFields = {
  summary: { type: 'string', description: 'One plain sentence, at most 24 words, leading with the news. Not "This note says".' },
  category: { type: 'string', enum: CATEGORIES },
  importance: { type: 'integer', description: '0 to 100, per the rubric.' },
  importance_reason: { type: 'string', description: 'At most 14 words: why it matters, or why it is routine.' },
};

const ENTRY_TOOL = {
  name: 'record_entries',
  description: 'Record what each case-file entry establishes.',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ref: { type: 'string', description: 'The ref of the entry, copied exactly.' }, ...entryFields, facts: { type: 'array', items: factSchema(false) } },
          required: ['ref', 'summary', 'category', 'importance', 'importance_reason', 'facts'],
        },
      },
    },
    required: ['entries'],
  },
};

const DOCUMENT_TOOL = {
  name: 'record_document',
  description: 'Record what one document, or one stretch of a long document, establishes.',
  input_schema: {
    type: 'object',
    properties: {
      doc_label: { type: 'string', description: 'What a lawyer would call this document in two words or fewer, upper case, at most 14 characters. Examples of the style: OP REPORT, MRI, ER CHART, COMPLAINT, IME, BILL.' },
      doc_type: { type: 'string', enum: DOC_TYPES },
      provider_contact_id: { type: ['string', 'null'], description: 'Roster id of the provider or party that issued this document, or null.' },
      ...entryFields,
      facts: { type: 'array', items: factSchema(true) },
      visits: {
        type: 'array',
        description: 'Medical records only: every date on which the patient was seen or treated according to these pages, each with the page it appears on. Empty for anything else.',
        items: { type: 'object', properties: { date: { type: 'string' }, page: { type: 'integer' } }, required: ['date', 'page'] },
      },
      portrait: {
        type: ['object', 'null'],
        description: "Only when a page shows a photograph of a person's face, such as a photo ID: the box around the face as fractions of the page, origin top left. Otherwise null.",
        properties: { page: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
      },
    },
    required: ['doc_label', 'doc_type', 'summary', 'category', 'importance', 'importance_reason', 'facts', 'visits'],
  },
};

// ---------------------------------------------------------------------------------------------
// Shared context and clean-up
// ---------------------------------------------------------------------------------------------

export function matterContext(matterId) {
  const matter = get("SELECT title, body FROM source_items WHERE matter_id = ? AND kind = 'matter' AND removed_at IS NULL", matterId);
  const people = roster(matterId);
  const lines = people.map((p) => `[${p.id}] ${p.name}${p.relationship ? ` — ${p.relationship}` : ''}`);
  return {
    people,
    text: `<matter>\n${matter?.body || matter?.title || ''}\n</matter>\n\n<roster>\n${lines.join('\n')}\n</roster>\n\nToday is ${today()}.`,
  };
}

const text = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? truncate(s, max) : null;
};

function cleanFact(f, rosterIds) {
  if (!f || typeof f !== 'object') return null;
  const detail = text(f.detail, 600);
  if (!detail) return null;
  const amount = Number(f.amount);
  const page = Number.parseInt(f.page, 10);
  return {
    type: FACT_TYPES.includes(f.type) ? f.type : 'other',
    title: text(f.title, 120) || truncate(detail, 60),
    detail,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(f.date || '')) ? f.date : isoDate(f.date),
    amount: f.amount != null && Number.isFinite(amount) ? amount : null,
    contact_id: f.contact_id != null && rosterIds.has(String(f.contact_id)) ? String(f.contact_id) : null,
    status: text(f.status, 40)?.toLowerCase() || null,
    quote: text(f.quote, 400),
    sensitivity: SENSITIVITY.includes(f.sensitivity) ? f.sensitivity : 'administrative',
    page: Number.isFinite(page) ? page : null,
  };
}

const insertFact = (matterId, sourceId, f, origin = 'ai') =>
  run(
    'INSERT INTO facts (matter_id, source_id, origin, page, type, title, detail, date, amount, contact_id, status, quote, quote_verified, sensitivity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    matterId, sourceId, origin, f.page ?? null, f.type, f.title, f.detail, f.date, f.amount, f.contact_id, f.status, f.quote, f.quote_verified ?? null, f.sensitivity,
  );

const cleanEntry = (e) => ({
  summary: text(e.summary, 300),
  category: CATEGORIES.includes(e.category) ? e.category : 'admin',
  importance: clamp(Number.parseInt(e.importance, 10) || 0, 0, 100),
  importance_reason: text(e.importance_reason, 200),
});

// ---------------------------------------------------------------------------------------------
// Notes, emails, calls, tasks, calendar entries, expenses
// ---------------------------------------------------------------------------------------------

function renderEntry(item) {
  const meta = parseJson(item.meta, {});
  const attrs = [`ref="${item.ref}"`, `kind="${item.kind}"`, item.date ? `date="${item.date}"` : null].filter(Boolean).join(' ');
  const head = [];
  if (item.kind === 'communication') head.push(`${meta.type === 'phone' ? 'Phone call' : 'Email'} from ${(meta.from || []).map((p) => p.name).join(', ') || 'unknown'} to ${(meta.to || []).map((p) => p.name).join(', ') || 'unknown'}`);
  if (item.kind === 'task') head.push(`Task, status ${meta.status || 'unknown'}, due ${item.date || 'no date'}${meta.assignee ? `, assigned to ${meta.assignee}` : ''}`);
  if (item.kind === 'calendar') head.push(`Calendar entry on ${item.date || 'no date'}`);
  if (item.kind === 'activity') head.push(`Case expense entry of $${Number(meta.amount || 0).toFixed(2)} (${meta.non_billable ? 'marked non-billable' : 'marked billable to the matter'})`);
  if (item.kind === 'note' && meta.author) head.push(`Note by ${meta.author}`);
  return `<entry ${attrs}>\n${head.length ? `${head.join('. ')}.\n` : ''}Subject: ${item.title || ''}\n\n${item.body || ''}\n</entry>`;
}

function batches(items) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const item of items) {
    const size = (item.title || '').length + (item.body || '').length + 120;
    if (cur.length && (cur.length >= TEXT_BATCH_ITEMS || chars + size > TEXT_BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(item);
    chars += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

function storeEntry(matterId, item, entry, rosterIds) {
  const meta = parseJson(item.meta, {});
  const haystack = squash(`${item.title}\n${item.body}`);
  const facts = (Array.isArray(entry.facts) ? entry.facts : []).map((f) => cleanFact(f, rosterIds)).filter(Boolean);
  for (const f of facts) {
    f.page = null;
    f.quote_verified = f.quote ? Number(haystack.includes(squash(f.quote))) : 0;
    f.date ??= ['client_contact', 'negotiation', 'court', 'records'].includes(f.type) ? item.date : null;
  }
  if (item.kind === 'activity' && Number(meta.amount) > 0) {
    // The dollar figure of an expense entry is Clio's, not the model's.
    const money = facts.filter((f) => f.type === 'bill' || f.type === 'firm_expense');
    for (const f of money) f.amount = Number(meta.amount);
    for (const extra of money.slice(1)) facts.splice(facts.indexOf(extra), 1);
    if (!money.length) {
      facts.push({ type: meta.non_billable ? 'bill' : 'firm_expense', title: truncate(item.title, 60), detail: truncate(item.body || item.title, 400), date: item.date, amount: Number(meta.amount), contact_id: null, status: null, quote: truncate(item.body || item.title, 200), quote_verified: 1, sensitivity: 'billing', page: null });
    }
    for (const f of facts) if ((f.type === 'bill' || f.type === 'firm_expense') && !f.date) f.date = item.date;
  }
  const e = cleanEntry(entry);
  tx(() => {
    run('DELETE FROM facts WHERE source_id = ?', item.id);
    for (const f of facts) insertFact(matterId, item.id, f);
    run('UPDATE source_items SET summary = ?, category = ?, importance = ?, importance_reason = ?, digested_hash = ?, digested_at = ?, digest_error = NULL WHERE id = ?', e.summary, e.category, e.importance, e.importance_reason, item.hash, now(), item.id);
  });
  return facts.length;
}

async function digestBatch(matterId, items, ctx, onDone) {
  const rosterIds = new Set(ctx.people.map((p) => p.id));
  try {
    const result = await callTool({
      step: 'extract:entries',
      model: config.ai.extractModel,
      system: SYSTEM,
      content: `${ctx.text}\n\nRecord the ${items.length} entries below. Return exactly one record per entry, using its ref exactly as given.\nFor a case expense entry (kind="activity"), always include exactly one fact of type "bill" (a medical provider's charges for treating the client) or "firm_expense" (a cost the firm paid to run the case).\n\n${items.map(renderEntry).join('\n\n')}`,
      tool: ENTRY_TOOL,
      maxTokens: 12000,
    });
    const byRef = new Map((Array.isArray(result.entries) ? result.entries : []).map((e) => [String(e?.ref || '').trim(), e]));
    for (const item of items) {
      const entry = byRef.get(item.ref);
      if (entry) storeEntry(matterId, item, entry, rosterIds);
      else run('UPDATE source_items SET digest_error = ? WHERE id = ?', 'The model skipped this entry. It will be retried on the next sync.', item.id);
      onDone(item, Boolean(entry));
    }
  } catch (err) {
    if (err instanceof LlmError && err.kind === 'auth') throw err;
    if (err instanceof LlmError && ['truncated', 'invalid'].includes(err.kind) && items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      await Promise.all([digestBatch(matterId, items.slice(0, mid), ctx, onDone), digestBatch(matterId, items.slice(mid), ctx, onDone)]);
      return;
    }
    for (const item of items) {
      run('UPDATE source_items SET digest_error = ? WHERE id = ?', truncate(err.message, 300), item.id);
      onDone(item, false);
    }
  }
}

export function pendingTextItems(matterId) {
  return all(
    "SELECT * FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND kind IN ('note','communication','task','calendar','activity') AND (digested_hash IS NULL OR digested_hash != hash) ORDER BY kind, date, id",
    matterId,
  );
}

export async function digestTextItems(matterId, items, onDone = () => {}) {
  if (!items.length) return;
  const ctx = matterContext(matterId);
  await Promise.all(batches(items).map((batch) => digestBatch(matterId, batch, ctx, onDone)));
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export function pendingDocuments(matterId) {
  return all(
    "SELECT * FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND kind = 'document' AND file_path IS NOT NULL AND page_count > 0 AND (digested_hash IS NULL OR digested_hash != hash) ORDER BY page_count, id",
    matterId,
  );
}

/** Split a document into model-sized jobs: stretches of text pages, and groups of bare scans for vision. */
function planDocument(item) {
  const extra = parseJson(item.extra, {});
  const pages = all('SELECT page, text FROM doc_pages WHERE source_id = ? ORDER BY page', item.id);
  const limit = Math.min(pages.length, config.ai.maxDocPages);
  const jobs = [];
  if (extra.file_kind === 'image') return { jobs: [{ mode: 'image', pages: [1] }], read: 1, pages };
  let cur = [];
  let chars = 0;
  const thin = [];
  for (const p of pages.slice(0, limit)) {
    const len = (p.text || '').length;
    if (extra.file_kind === 'pdf' && len < THIN_PAGE) {
      thin.push(p.page);
      continue;
    }
    if (cur.length && chars + len > DOC_CHUNK_CHARS) {
      jobs.push({ mode: 'text', pages: cur });
      cur = [];
      chars = 0;
    }
    cur.push(p.page);
    chars += len;
  }
  if (cur.length) jobs.push({ mode: 'text', pages: cur });
  for (let i = 0; i < thin.length; i += VISION_PAGES_PER_CALL) jobs.push({ mode: 'vision', pages: thin.slice(i, i + VISION_PAGES_PER_CALL) });
  jobs.sort((a, b) => a.pages[0] - b.pages[0]);
  return { jobs, read: limit, pages };
}

async function runDocumentJob(item, job, index, total, ctx, plan) {
  const meta = parseJson(item.meta, {});
  const extra = parseJson(item.extra, {});
  const range = job.pages.length === 1 ? `page ${job.pages[0]}` : `pages ${job.pages[0]} to ${job.pages[job.pages.length - 1]}`;
  const intro = `${ctx.text}\n\nDocument "${item.title}"${meta.folder ? ` from the folder "${meta.folder}"` : ''}, ${plan.pages.length} page${plan.pages.length === 1 ? '' : 's'} in total.${total > 1 ? ` This is part ${index + 1} of ${total}, covering ${range}.` : ''}\nFor repetitive visit notes, do not record one fact per visit: list every visit date in "visits" and keep facts for the first visit, changes in diagnosis or plan, work status, discharge, gaps, and anything unusual or inconsistent.`;
  let content;
  if (job.mode === 'text') {
    const byPage = new Map(plan.pages.map((p) => [p.page, p.text]));
    content = `${intro}\n\n${job.pages.map((n) => `<page n="${n}">\n${byPage.get(n) || ''}\n</page>`).join('\n')}`;
  } else if (job.mode === 'image') {
    const bytes = fs.readFileSync(documentPath(item));
    content = [
      { type: 'image', source: { type: 'base64', media_type: extra.media || 'image/jpeg', data: bytes.toString('base64') } },
      { type: 'text', text: `${intro}\n\nThe image above is the whole document. Use page 1 for every fact.` },
    ];
  } else {
    const whole = fs.readFileSync(documentPath(item));
    const pdf = job.pages.length === plan.pages.length ? whole : await subsetPdf(whole, job.pages);
    const mapping = job.pages.map((n, i) => `attached page ${i + 1} is original page ${n}`).join('; ');
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
      { type: 'text', text: `${intro}\n\nThe attached PDF holds scanned pages with no text layer. Read them as images. ${mapping}. Always report the original page number.` },
    ];
  }
  return callTool({ step: `extract:document:${job.mode}`, model: config.ai.extractModel, system: SYSTEM, content, tool: DOCUMENT_TOOL, maxTokens: 8000 });
}

export async function digestDocument(matterId, item, ctx = matterContext(matterId)) {
  const rosterIds = new Set(ctx.people.map((p) => p.id));
  const plan = planDocument(item);
  if (!plan.jobs.length) {
    run('UPDATE source_items SET digested_hash = hash, digested_at = ?, pages_read = 0 WHERE id = ?', now(), item.id);
    return { facts: 0, failed: 0 };
  }
  const results = await Promise.all(
    plan.jobs.map((job, i) =>
      runDocumentJob(item, job, i, plan.jobs.length, ctx, plan).then(
        (value) => ({ job, value }),
        (error) => {
          if (error instanceof LlmError && error.kind === 'auth') throw error;
          return { job, error };
        },
      ),
    ),
  );
  const good = results.filter((r) => r.value);
  const failed = results.length - good.length;
  const pageText = new Map(plan.pages.map((p) => [p.page, squash(p.text)]));
  const facts = [];
  const visits = new Map();
  let portrait = null;
  for (const { job, value } of good) {
    const allowed = new Set(job.pages);
    for (const raw of Array.isArray(value.facts) ? value.facts : []) {
      const f = cleanFact(raw, rosterIds);
      if (!f) continue;
      if (!allowed.has(f.page)) f.page = job.pages[0];
      if (job.mode === 'text' && f.quote) {
        const q = squash(f.quote);
        // Trust the text over the model for where a quote sits: move the fact to the page that actually contains it.
        const home = pageText.get(f.page)?.includes(q) ? f.page : job.pages.find((n) => pageText.get(n)?.includes(q));
        f.quote_verified = home ? 1 : 0;
        if (home) f.page = home;
      } else f.quote_verified = null;
      facts.push(f);
    }
    for (const v of Array.isArray(value.visits) ? value.visits : []) {
      const date = isoDate(v?.date);
      const page = Number.parseInt(v?.page, 10);
      if (date && !visits.has(date)) visits.set(date, allowed.has(page) ? page : job.pages[0]);
    }
    const p = value.portrait;
    if (p && [p.x, p.y, p.w, p.h].every((n) => Number.isFinite(Number(n))) && Number(p.w) > 0 && Number(p.h) > 0) portrait = { page: allowed.has(Number(p.page)) ? Number(p.page) : job.pages[0], x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1), w: clamp(Number(p.w), 0.02, 1), h: clamp(Number(p.h), 0.02, 1) };
  }
  const first = good[0]?.value;
  const head = first ? cleanEntry(first) : null;
  const importance = good.reduce((m, r) => Math.max(m, clamp(Number.parseInt(r.value.importance, 10) || 0, 0, 100)), 0);
  const providerId = good.map((r) => r.value.provider_contact_id).find((id) => id != null && rosterIds.has(String(id)));
  const extra = {
    ...parseJson(item.extra, {}),
    provider_contact_id: providerId != null ? String(providerId) : null,
    visits: [...visits.entries()].map(([date, page]) => ({ date, page })).sort((a, b) => a.date.localeCompare(b.date)),
    portrait,
    parts: plan.jobs.length,
    parts_failed: failed,
    pages_unread: plan.pages.length - plan.read,
  };
  tx(() => {
    run('DELETE FROM facts WHERE source_id = ?', item.id);
    for (const f of facts) {
      if (!f.contact_id && extra.provider_contact_id && ['bill', 'treatment', 'records', 'injury', 'procedure'].includes(f.type)) f.contact_id = extra.provider_contact_id;
      insertFact(matterId, item.id, f);
    }
    run(
      'UPDATE source_items SET summary = ?, category = ?, importance = ?, importance_reason = ?, doc_label = ?, doc_type = ?, pages_read = ?, extra = ?, digested_hash = ?, digested_at = ?, digest_error = ? WHERE id = ?',
      head?.summary ?? null, head?.category ?? null, head ? importance : null, head?.importance_reason ?? null,
      first ? text(String(first.doc_label || '').toUpperCase(), 14) : null,
      first && DOC_TYPES.includes(first.doc_type) ? first.doc_type : first ? 'other' : null,
      plan.read, JSON.stringify(extra),
      failed ? null : item.hash, now(),
      failed ? `${failed} of ${plan.jobs.length} parts could not be read (${truncate(results.find((r) => r.error)?.error?.message || 'unknown error', 160)}). They will be retried on the next sync.` : null,
      item.id,
    );
  });
  return { facts: facts.length, failed };
}
