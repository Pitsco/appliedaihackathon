// Step 3 of the pipeline: write the brief from the fact ledger.
//
// The model sees only facts (each with an id), never raw documents, and must cite fact ids
// for everything it says. The application resolves those ids back to the note, email or page.
// Money is never added up by the model: it copies figures, the application does the sums.
import { config } from './config.js';
import { all, get, run, now, parseJson } from './db.js';
import { callTool } from './llm.js';
import { matterContext, CATEGORIES, rosterId } from './extract.js';
import { daysBetween, today, truncate, isoDate, clamp } from './util.js';

const REGIONS = ['head', 'neck', 'chest', 'upper_back', 'lower_back', 'abdomen', 'left_shoulder', 'right_shoulder', 'left_arm', 'right_arm', 'left_hand', 'right_hand', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_leg', 'right_leg', 'left_ankle', 'right_ankle', 'whole_body', 'other'];
const SHARE_TOPICS = ['status', 'stage', 'coverage', 'coverage_limit', 'payment', 'timeline', 'treatment', 'value', 'liability', 'negotiation', 'strategy', 'other'];

const SYSTEM = `You are chief of staff to the supervising attorney at a plaintiff personal-injury law firm. From the fact ledger of one matter you write the brief that brings a lawyer who has never opened the file up to speed in ninety seconds. Lawyers act on what you write, so:

- Use only the ledger. Never invent facts, figures, dates, names or legal rules. If the ledger does not say, write "not in the file".
- Every statement carries "cites": the ids of the ledger facts that prove it, written like "f123". No cite, no statement. Cite the most direct fact, usually one to three ids.
- Never do arithmetic on money. Copy amounts exactly as the ledger states them. The application computes totals.
- The file moves on. Prefer the most recent fact, and when older and newer entries disagree, or two sources state different things, say so under "conflicts" instead of quietly choosing one.
- Do not state a legal deadline or rule the ledger does not state. Do not give legal advice.
- Write plainly, in short sentences, in the firm's voice. No filler and no hedging words. Sentence case, no exclamation marks.`;

const cites = { type: 'array', items: { type: 'string' }, description: 'Ledger fact ids that prove this, like "f123".' };
const obj = (properties, required) => ({ type: 'object', properties, required: required || Object.keys(properties) });
const str = (description) => ({ type: 'string', description });
const nullable = (type, description) => ({ type: [type, 'null'], description });

const CASE_TOOL = {
  name: 'write_case_brief',
  description: 'Write the attorney brief for this matter from the fact ledger.',
  input_schema: obj({
    case_type: str('Kind of case in a few words, lower case, for example "motor vehicle collision".'),
    incident: obj({ date: nullable('string', 'Date of the injury event, YYYY-MM-DD.'), location: nullable('string', 'Where it happened, short.'), summary: str('What happened, one neutral sentence of at most 28 words.'), cites }),
    stage_track: {
      type: 'array',
      description: 'Five to seven stages for a case like this one, in order from intake to resolution, in the words lawyers use. Mark every stage done, current or upcoming. Exactly one is current.',
      items: obj({ label: str('One or two words.'), state: { type: 'string', enum: ['done', 'current', 'upcoming'] } }),
    },
    status: obj({ line: str('Where the case stands today, one sentence of at most 20 words.'), detail: str('One more sentence: what is holding it there, or what happens next.'), cites }),
    limitations: obj({
      state: { type: 'string', enum: ['suit_filed', 'running', 'at_risk', 'expired', 'unknown'], description: 'suit_filed once a lawsuit has been filed. running if the ledger gives a deadline that is still ahead. unknown if the ledger does not state the deadline.' },
      headline: str('At most 5 words, for example "Suit filed" or "Deadline to file".'),
      date: nullable('string', 'The date that matters, YYYY-MM-DD: the filing date if suit is filed, otherwise the deadline to file if the ledger states one.'),
      detail: str('One sentence on what the ledger says about the time limit and any special notice rule. If it does not state the deadline, say so. Never work a deadline out from general legal knowledge.'),
      cites,
    }),
    next_date: obj({ date: nullable('string', 'YYYY-MM-DD or null.'), label: nullable('string', 'What happens on it, at most 8 words.'), cites }),
    fault: obj({ status: { type: 'string', enum: ['clear', 'contested', 'weak', 'unknown'] }, headline: str('Who caused it, at most 9 words.'), plain: str('Why, in at most 40 words a non-lawyer would follow.'), cites }),
    coverage: obj({
      status: { type: 'string', enum: ['confirmed', 'disputed', 'unconfirmed', 'none', 'unknown'] },
      headline: str('The money behind the case, at most 9 words.'),
      plain: str('Who would pay and what limits recovery, at most 40 words.'),
      limit: nullable('number', 'The per-person limit that caps recovery, if the ledger states one.'),
      cites,
    }),
    damages: obj({ status: { type: 'string', enum: ['strong', 'documented', 'developing', 'thin', 'unknown'] }, headline: str('The harm, at most 9 words.'), plain: str('What the injuries and losses are and how well they are proven, at most 40 words.'), cites }),
    case_value: obj({ amount: nullable('number', "The firm's own valuation, if the ledger states one."), low: nullable('number', 'Low end if the ledger gives a range.'), high: nullable('number', 'High end if the ledger gives a range.'), basis: str('Where the figure comes from and what caps or moves it, at most 30 words.'), cites }),
    medical_bills_stated: obj({ amount: nullable('number', 'The running total of medical bills as the file itself states it.'), note: str('Whether the file calls it final or interim, at most 16 words.'), cites }),
    wage_loss: obj({ amount: nullable('number', 'Wage loss claimed.'), basis: str('What supports it, at most 20 words.'), cites }),
    liens: { type: 'array', items: obj({ holder: str('Who holds it.'), amount: nullable('number', 'Asserted amount.'), note: str('At most 14 words.'), cites }) },
    offers: { type: 'array', description: 'Demands and offers, oldest first.', items: obj({ date: nullable('string', 'YYYY-MM-DD.'), from: str('Who made it.'), amount: nullable('number', 'Amount if the ledger states one.'), summary: str('At most 20 words.'), cites }) },
    injuries: {
      type: 'array',
      description: 'Each injury or condition the client claims, most serious first. At most 8.',
      items: obj({
        name: str('The medical name, short.'),
        plain: str('The same thing explained so a twelve-year-old would understand, one sentence.'),
        region: { type: 'string', enum: REGIONS },
        severity: { type: 'string', enum: ['major', 'moderate', 'minor'] },
        status: str('Where it stands, at most 8 words, for example "surgery done", "surgery recommended, no date", "in therapy".'),
        cites,
      }),
    },
    pitch: {
      type: 'array',
      description: 'The case as you would tell it aloud to a colleague in sixty seconds: five to seven sentences covering what happened, who is on the other side, the injuries, the money, where it stands, the biggest risk and the next move.',
      items: obj({ text: str('One sentence.'), cites }),
    },
  }),
};

const ANALYSIS_TOOL = {
  name: 'write_case_analysis',
  description: 'Write the analysis that sits beside the brief: what is outstanding, where the file contradicts itself, which entries to read, and what a provider may be told.',
  input_schema: obj({
    waiting_on: {
      type: 'array',
      description: 'Things the firm is waiting for from someone outside the firm, most pressing first. At most 8.',
      items: obj({ what: str('At most 12 words.'), who: str('Who owes it.'), since: nullable('string', 'Date first asked, YYYY-MM-DD.'), attempts: nullable('integer', 'How many times the firm has asked, if the ledger says.'), cites }),
    },
    conflicts: {
      type: 'array',
      description: 'Places where the file disagrees with itself: two entries stating different facts, numbers or dates, an account that changed, a record that contradicts a statement. Most serious first. At most 10. Cite both sides.',
      items: obj({ title: str('At most 9 words.'), detail: str('What each side says, at most 45 words.'), severity: { type: 'string', enum: ['high', 'medium', 'low'] }, cites }),
    },
    top_entries: {
      type: 'array',
      description: 'From the entry list, the ten entries an attorney should read first, most important first. Avoid picking two entries that say the same thing.',
      items: obj({ ref: str('The entry ref, copied exactly.'), why: str('Why it matters, at most 14 words.'), category: { type: 'string', enum: CATEGORIES } }),
    },
    sharing: {
      type: 'array',
      description:
        "Eight to twelve things a treating medical provider would want to know about this case. A provider is not part of the firm. They are owed: whether the case is alive, what stage it is at, whether there is money behind it, and what happens next that affects them. They are not owed: the firm's strategy, its view of the strengths and weaknesses, the case value, settlement talks, doubts about the client, or anything about other providers. Include the sensitive items too, marked withhold, so the attorney sees what is being held back.",
      items: obj({
        topic: { type: 'string', enum: SHARE_TOPICS },
        label: str('At most 5 words.'),
        text: str('What the provider would read, at most 40 words, in neutral words with no strategy. For a withheld item, write what would be shown if the attorney chose to share it.'),
        decision: { type: 'string', enum: ['share', 'withhold'] },
        reason: str('Why, at most 16 words, addressed to the attorney.'),
        cites,
      }),
    },
  }),
};

const PROVIDER_TOOL = {
  name: 'write_provider_table',
  description: 'Write one row per medical provider who treated the client.',
  input_schema: obj({
    providers: {
      type: 'array',
      description: 'Every medical provider in the roster who treated, examined or billed for the client on this claim. Not insurers, not defendants, not defence examiners. Put a practice and its own doctor together as one provider.',
      items: obj({
        contact_ids: { type: 'array', items: { type: 'string' }, description: 'Roster ids that belong to this provider.' },
        name: str('Name as the firm would say it.'),
        role: str('What they do, at most 5 words.'),
        treatment_status: { type: 'string', enum: ['treating', 'procedure_pending', 'finished', 'not_started', 'unknown'], description: 'treating if the client is still being seen. procedure_pending if a recommended procedure has not happened. finished if care with this provider is over.' },
        status_note: str('At most 14 words, for example how often or what is pending.'),
        last_visit: nullable('string', 'Most recent visit the ledger documents, YYYY-MM-DD.'),
        records_status: { type: 'string', enum: ['received', 'partial', 'requested', 'overdue', 'none', 'unknown'], description: 'received if the firm holds everything. partial if it holds records but updates are outstanding. requested if asked and not yet due. overdue if asked and late.' },
        records_note: str('At most 14 words.'),
        billed: nullable('number', "This provider's charges as stated in the ledger."),
        billed_through: nullable('string', 'Last service date the bill covers, YYYY-MM-DD.'),
        paid_by: nullable('string', 'How this provider is being paid, at most 4 words, if the ledger says: for example no-fault, Medicaid, lien.'),
        needs_from_them: nullable('string', "What the firm needs from this provider's office right now, one polite sentence addressed to the office, with no strategy. Null if nothing."),
        cites,
      }),
    },
  }),
};

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

function describeSource(r) {
  const meta = parseJson(r.s_meta, {});
  switch (r.kind) {
    case 'note': return `note ${r.s_date || ''}`.trim();
    case 'communication': return `${meta.type === 'phone' ? 'call' : 'email'} ${r.s_date || ''}`.trim();
    case 'document': return `document ${r.doc_label || truncate(r.s_title, 40)}${r.page ? ` p.${r.page}` : ''}`;
    case 'task': return `task due ${r.s_date || 'no date'}, ${meta.status || 'open'}`;
    case 'calendar': return `calendar ${r.s_date || ''}`.trim();
    case 'activity': return `expense entry ${r.s_date || ''}`.trim();
    case 'field': return 'Clio custom field';
    case 'contact': return 'Clio contact';
    default: return 'Clio matter record';
  }
}

// How much an attorney's brief depends on each kind of fact. Used only to decide what to
// leave out when the ledger is too long for one request; nothing is ever left out of the database.
const WEIGHT = { valuation: 10, coverage: 10, negotiation: 9, deadline: 10, liability: 9, risk: 9, incident: 9, court: 8, procedure: 8, injury: 8, lien: 8, wage_loss: 8, expert: 7, prior_history: 7, payer: 6, treatment: 6, field: 9, matter: 9, party: 7, discovery: 6, employment: 6, bill: 6, firm_expense: 5, records: 5, client_contact: 4, other: 2 };

export function ledger(matterId, people, { types = null, budget = config.ai.ledgerChars } = {}) {
  let rows = all(
    `SELECT f.*, s.kind, s.title AS s_title, s.date AS s_date, s.doc_label, s.meta AS s_meta, s.importance AS s_importance
       FROM facts f JOIN source_items s ON s.id = f.source_id
      WHERE f.matter_id = ? AND s.removed_at IS NULL
      ORDER BY COALESCE(f.date, s.date, '0000'), f.id`,
    matterId,
  );
  if (types) rows = rows.filter((r) => types.includes(r.type));
  const name = new Map(people.map((p) => [p.id, p.name]));
  const line = (r) => {
    const parts = [`f${r.id}`, r.type, r.date || r.s_date || 'undated'];
    if (r.amount != null) parts.push(`$${Number(r.amount).toLocaleString('en-US')}`);
    if (r.status) parts.push(r.status);
    if (r.contact_id && name.has(r.contact_id)) parts.push(`re ${name.get(r.contact_id)} [${r.contact_id}]`);
    return `${parts.join(' · ')} — ${r.detail} (${describeSource(r)})`;
  };
  let lines = rows.map((r) => ({ r, text: line(r) }));
  const total = lines.reduce((a, l) => a + l.text.length + 1, 0);
  let omitted = 0;
  if (total > budget) {
    // Keep the facts that matter most, then put them back in date order.
    const score = (r) => (WEIGHT[r.type] ?? 3) * 10 + (r.s_importance ?? 40) / 10 + (r.origin === 'clio' ? 20 : 0);
    const ranked = [...lines].sort((x, y) => score(y.r) - score(x.r));
    const keep = new Set();
    let used = 0;
    for (const l of ranked) {
      if (used + l.text.length + 1 > budget) continue;
      used += l.text.length + 1;
      keep.add(l.r.id);
    }
    omitted = lines.length - keep.size;
    lines = lines.filter((l) => keep.has(l.r.id));
  }
  return { text: lines.map((l) => l.text).join('\n'), ids: new Set(lines.map((l) => l.r.id)), count: lines.length, omitted };
}

function entryList(matterId) {
  const rows = all(
    "SELECT ref, kind, date, title, summary, importance FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND importance IS NOT NULL AND kind IN ('note','communication','document','task','calendar','activity') ORDER BY importance DESC, date DESC LIMIT 70",
    matterId,
  );
  return { text: rows.map((r) => `${r.ref} · ${r.kind} · ${r.date || 'undated'} · importance ${r.importance} · ${truncate(r.title, 70)} — ${r.summary || ''}`).join('\n'), refs: new Set(rows.map((r) => r.ref)) };
}

function openWork(matterId) {
  const t = today();
  const tasks = all("SELECT title, body, date, meta FROM source_items WHERE matter_id = ? AND kind = 'task' AND removed_at IS NULL ORDER BY date", matterId)
    .filter((r) => !['complete', 'completed'].includes(parseJson(r.meta, {}).status))
    .map((r) => `task · due ${r.date || 'no date'}${r.date && r.date < t ? ` · OVERDUE ${daysBetween(r.date, t)} days` : ''} · ${r.title} — ${truncate(r.body, 200)}`);
  const events = all("SELECT title, body, date FROM source_items WHERE matter_id = ? AND kind = 'calendar' AND removed_at IS NULL AND date >= ? ORDER BY date", matterId, t).map((r) => `calendar · ${r.date} · ${r.title} — ${truncate(r.body, 200)}`);
  return [...tasks, ...events].join('\n');
}

/** Visit dates the documents record, per provider, with gaps of more than 30 days. Plain arithmetic, no AI. */
export function visitStats(matterId) {
  const docs = all("SELECT id, title, doc_label, extra FROM source_items WHERE matter_id = ? AND kind = 'document' AND removed_at IS NULL", matterId);
  const stats = new Map();
  for (const d of docs) {
    const extra = parseJson(d.extra, {});
    if (!extra.provider_contact_id || !Array.isArray(extra.visits) || !extra.visits.length) continue;
    const s = stats.get(extra.provider_contact_id) || { dates: new Map() };
    for (const v of extra.visits) if (!s.dates.has(v.date)) s.dates.set(v.date, { source_id: d.id, page: v.page });
    stats.set(extra.provider_contact_id, s);
  }
  const out = new Map();
  for (const [contactId, s] of stats) {
    const dates = [...s.dates.keys()].sort();
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      const days = daysBetween(dates[i - 1], dates[i]);
      if (days > 30) gaps.push({ from: dates[i - 1], to: dates[i], days });
    }
    out.set(contactId, { count: dates.length, first: dates[0], last: dates[dates.length - 1], gaps, where: s.dates });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Clean-up of what the model returns
// ---------------------------------------------------------------------------------------------

const s = (v, max = 400) => (typeof v === 'string' && v.trim() ? truncate(v.trim(), max) : null);
const n = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const d = (v) => (v ? isoDate(v) : null);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === 'object') : []);

function citeIds(value, valid) {
  const out = [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : [];
  for (const c of raw) {
    const id = Number.parseInt(String(c).replace(/[^0-9]/g, ''), 10);
    if (valid.has(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 6);
}

/** An entry ref however the model wrote it, e.g. "note:123" inside brackets or with trailing text. */
const entryRef = (v) => /(note|comm|doc|task|event|activity):[0-9A-Za-z_-]+/.exec(String(v ?? ''))?.[0] || null;

function cleanCase(raw, valid, refs) {
  const c = (o) => citeIds(o?.cites, valid);
  const block = (o, statuses, fallback) => ({ status: pick(o?.status, statuses, fallback), headline: s(o?.headline, 120), plain: s(o?.plain, 400), cites: c(o) });
  const track = list(raw.stage_track, 8).map((x) => ({ label: s(x.label, 30), state: pick(x.state, ['done', 'current', 'upcoming'], 'upcoming') })).filter((x) => x.label);
  return {
    case_type: s(raw.case_type, 80),
    incident: { date: d(raw.incident?.date), location: s(raw.incident?.location, 120), summary: s(raw.incident?.summary, 300), cites: c(raw.incident) },
    stage_track: track,
    status: { line: s(raw.status?.line, 240), detail: s(raw.status?.detail, 300), cites: c(raw.status) },
    limitations: { state: pick(raw.limitations?.state, ['suit_filed', 'running', 'at_risk', 'expired', 'unknown'], 'unknown'), headline: s(raw.limitations?.headline, 60), date: d(raw.limitations?.date), detail: s(raw.limitations?.detail, 400), cites: c(raw.limitations) },
    next_date: { date: d(raw.next_date?.date), label: s(raw.next_date?.label, 100), cites: c(raw.next_date) },
    fault: block(raw.fault, ['clear', 'contested', 'weak', 'unknown'], 'unknown'),
    coverage: { ...block(raw.coverage, ['confirmed', 'disputed', 'unconfirmed', 'none', 'unknown'], 'unknown'), limit: n(raw.coverage?.limit) },
    damages: block(raw.damages, ['strong', 'documented', 'developing', 'thin', 'unknown'], 'unknown'),
    case_value: { amount: n(raw.case_value?.amount), low: n(raw.case_value?.low), high: n(raw.case_value?.high), basis: s(raw.case_value?.basis, 300), cites: c(raw.case_value) },
    medical_bills_stated: { amount: n(raw.medical_bills_stated?.amount), note: s(raw.medical_bills_stated?.note, 200), cites: c(raw.medical_bills_stated) },
    wage_loss: { amount: n(raw.wage_loss?.amount), basis: s(raw.wage_loss?.basis, 240), cites: c(raw.wage_loss) },
    liens: list(raw.liens, 8).map((x) => ({ holder: s(x.holder, 100), amount: n(x.amount), note: s(x.note, 200), cites: c(x) })).filter((x) => x.holder),
    offers: list(raw.offers, 12).map((x) => ({ date: d(x.date), from: s(x.from, 100), amount: n(x.amount), summary: s(x.summary, 240), cites: c(x) })).filter((x) => x.summary),
    injuries: list(raw.injuries, 8).map((x) => ({ name: s(x.name, 120), plain: s(x.plain, 300), region: pick(x.region, REGIONS, 'other'), severity: pick(x.severity, ['major', 'moderate', 'minor'], 'moderate'), status: s(x.status, 100), cites: c(x) })).filter((x) => x.name),
    waiting_on: list(raw.waiting_on, 8).map((x) => ({ what: s(x.what, 160), who: s(x.who, 100), since: d(x.since), attempts: n(x.attempts), cites: c(x) })).filter((x) => x.what),
    conflicts: list(raw.conflicts, 10).map((x) => ({ title: s(x.title, 120), detail: s(x.detail, 500), severity: pick(x.severity, ['high', 'medium', 'low'], 'medium'), cites: c(x) })).filter((x) => x.title && x.cites.length),
    pitch: list(raw.pitch, 8).map((x) => ({ text: s(x.text, 400), cites: c(x) })).filter((x) => x.text),
    top_entries: list(raw.top_entries, 10).map((x) => ({ ref: entryRef(x.ref), why: s(x.why, 160), category: pick(x.category, CATEGORIES, 'admin') })).filter((x) => x.ref && refs.has(x.ref)),
    sharing: list(raw.sharing, 14).map((x) => ({ topic: pick(x.topic, SHARE_TOPICS, 'other'), label: s(x.label, 60), text: s(x.text, 400), decision: pick(x.decision, ['share', 'withhold'], 'withhold'), reason: s(x.reason, 200), cites: c(x) })).filter((x) => x.label && x.text),
  };
}

function cleanProviders(raw, valid, rosterIds) {
  const seen = new Set();
  return list(raw.providers, 40)
    .map((p) => {
      const ids = (Array.isArray(p.contact_ids) ? p.contact_ids : [p.contact_ids]).map((id) => rosterId(id, rosterIds)).filter((id) => id && !seen.has(id));
      ids.forEach((id) => seen.add(id));
      return {
        contact_ids: ids,
        name: s(p.name, 120),
        role: s(p.role, 60),
        treatment_status: pick(p.treatment_status, ['treating', 'procedure_pending', 'finished', 'not_started', 'unknown'], 'unknown'),
        status_note: s(p.status_note, 160),
        last_visit: d(p.last_visit),
        records_status: pick(p.records_status, ['received', 'partial', 'requested', 'overdue', 'none', 'unknown'], 'unknown'),
        records_note: s(p.records_note, 160),
        billed: n(p.billed),
        billed_through: d(p.billed_through),
        paid_by: s(p.paid_by, 40),
        needs_from_them: s(p.needs_from_them, 300),
        cites: citeIds(p.cites, valid),
      };
    })
    .filter((p) => p.name && p.contact_ids.length);
}

// ---------------------------------------------------------------------------------------------
// The two calls
// ---------------------------------------------------------------------------------------------

export async function synthesize(matterId, { partial = false } = {}) {
  const ctx = matterContext(matterId);
  const book = ledger(matterId, ctx.people);
  if (!book.count) return null;
  const entries = entryList(matterId);
  const rosterIds = new Set(ctx.people.map((p) => p.id));
  const stats = visitStats(matterId);
  const visitLines = [...stats.entries()].map(([id, v]) => `[${id}] ${v.count} visits documented, first ${v.first}, last ${v.last}${v.gaps.length ? `; gaps over 30 days: ${v.gaps.map((g) => `${g.from} to ${g.to} (${g.days} days)`).join(', ')}` : ''}`);
  const omitted = book.omitted ? `\n(${book.omitted} lower-priority facts were left out of this ledger to keep it short. They remain in the file.)` : '';

  // All three calls share one system prompt: the instructions, then the case material. The
  // material is marked cacheable, so the second and third calls reuse it instead of paying
  // for (and being rate limited on) the same ledger three times.
  const material = `${ctx.text}\n\n<ledger>\n${book.text}\n</ledger>${omitted}\n\n<open_work>\n${openWork(matterId) || 'none'}\n</open_work>\n\n<entries>\n${entries.text}\n</entries>\n\n<visits_counted_from_records>\n${visitLines.join('\n') || 'none yet'}\n</visits_counted_from_records>${partial ? '\n\nNote: the documents are still being read. This first brief rests on notes, emails, tasks and expenses only.' : ''}`;
  const system = [
    { type: 'text', text: SYSTEM },
    { type: 'text', text: material, cache_control: { type: 'ephemeral' } },
  ];
  const tools = [CASE_TOOL, ANALYSIS_TOOL, PROVIDER_TOOL];
  const ask = (step, tool, content, maxTokens) => callTool({ step, model: config.ai.synthModel, system, content, tool, tools, maxTokens });

  // The core brief first (it also warms the cache), then the other two side by side.
  const caseRaw = await ask('brief:case', CASE_TOOL, 'Write the brief.', 6000);
  const [analysis, providers] = await Promise.allSettled([
    ask('brief:analysis', ANALYSIS_TOOL, 'Write the analysis: what the firm is waiting on, where the file disagrees with itself, the ten entries to read first, and what a treating provider may be told.', 6000),
    ask('brief:providers', PROVIDER_TOOL, 'Write the provider table. Use the visit counts for last visits where they are later than what the notes say.', 5000),
  ]);
  const warnings = [];
  for (const [name, result] of [['analysis', analysis], ['provider table', providers]]) {
    if (result.status === 'fulfilled') continue;
    if (result.reason?.kind === 'auth') throw result.reason;
    warnings.push(`The ${name} could not be written (${result.reason?.message || 'unknown error'}). Sync again to retry.`);
  }

  const brief = {
    case: cleanCase({ ...caseRaw, ...(analysis.status === 'fulfilled' ? analysis.value : {}) }, book.ids, entries.refs),
    providers: providers.status === 'fulfilled' ? cleanProviders(providers.value, book.ids, rosterIds) : [],
    facts_used: book.count,
    facts_omitted: book.omitted,
    warnings,
  };
  // A failed part keeps what an earlier brief had, so one bad call never empties the page.
  const previous = loadBrief(matterId);
  if (previous && analysis.status !== 'fulfilled') for (const k of ['waiting_on', 'conflicts', 'top_entries', 'sharing']) brief.case[k] = previous.case?.[k] || [];
  if (previous && providers.status !== 'fulfilled') brief.providers = previous.providers || [];
  run(
    'INSERT INTO briefs (matter_id, json, partial, generated_at, model) VALUES (?,?,?,?,?) ON CONFLICT (matter_id) DO UPDATE SET json = excluded.json, partial = excluded.partial, generated_at = excluded.generated_at, model = excluded.model',
    matterId, JSON.stringify(brief), partial || warnings.length ? 1 : 0, now(), config.ai.synthModel,
  );
  return brief;
}

export const loadBrief = (matterId) => {
  const row = get('SELECT json, partial, generated_at, model FROM briefs WHERE matter_id = ?', matterId);
  if (!row) return null;
  const brief = parseJson(row.json, null);
  return brief ? { ...brief, partial: Boolean(row.partial), generated_at: row.generated_at, model: row.model } : null;
};

export { REGIONS, clamp };
