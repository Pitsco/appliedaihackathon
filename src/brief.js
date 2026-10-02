// Assembles what the attorney page shows. Two kinds of content, kept apart on purpose:
//   - computed here from Clio's structured data (overdue tasks, last client contact, sums of
//     expense entries, visit gaps): plain code, no AI, always current;
//   - written by the AI from the fact ledger (stage, fault, coverage, injuries, conflicts),
//     every statement resolved back to the source item and page it cites.
import fs from 'node:fs';
import path from 'node:path';
import { config, aiConfigured } from './config.js';
import { all, get, run, getSetting, setSetting, parseJson, now } from './db.js';
import { roster, documentPath } from './pull.js';
import { loadBrief, visitStats } from './synthesize.js';
import { largestJpeg } from './pdf.js';
import { today, daysBetween, addDays, truncate } from './util.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DONE = new Set(['complete', 'completed', 'done']);
const SESSION_MS = 30 * 60 * 1000;

export const activeMatterId = () =>
  config.clio.matterId || getSetting('matter_id') || get("SELECT matter_id FROM source_items WHERE kind = 'matter' ORDER BY id DESC LIMIT 1")?.matter_id || null;

export function shortDate(iso, year = 'auto') {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  const base = `${MONTHS[m - 1]} ${d}`;
  return year === 'always' || (year === 'auto' && y !== new Date().getFullYear()) ? `${base}, ${y}` : base;
}

/** The little label on a source chip: where a fact came from, at a glance. */
export function chipLabel(s, page) {
  const meta = typeof s.meta === 'string' ? parseJson(s.meta, {}) : s.meta || {};
  const when = s.date ? shortDate(s.date).toUpperCase().replace(',', '') : '';
  switch (s.kind) {
    case 'note': return `NOTE · ${when}`;
    case 'communication': return `${meta.type === 'phone' ? 'CALL' : 'EMAIL'} · ${when}`;
    case 'document': return `${(s.doc_label || 'DOC').toUpperCase()}${page ? ` · P.${page}` : ''}`;
    case 'task': return `TASK · ${when ? `DUE ${when}` : 'NO DATE'}`;
    case 'calendar': return `CALENDAR · ${when}`;
    case 'activity': return `EXPENSE · ${when}`;
    case 'field': return 'CLIO FIELD';
    case 'contact': return 'CLIO CONTACT';
    default: return 'CLIO MATTER';
  }
}

function citeResolver(matterId) {
  const rows = all(
    'SELECT f.id, f.page, f.source_id, s.kind, s.date, s.doc_label, s.meta FROM facts f JOIN source_items s ON s.id = f.source_id WHERE f.matter_id = ? AND s.removed_at IS NULL',
    matterId,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (ids, max = 3) => {
    const out = [];
    const seen = new Set();
    for (const id of ids || []) {
      const r = byId.get(id);
      if (!r) continue;
      const key = `${r.source_id}:${r.page ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ fact: r.id, source: r.source_id, page: r.page, label: chipLabel(r, r.page) });
    }
    return out.slice(0, max);
  };
}

const itemChip = (row, page = null) => ({ fact: null, source: row.id, page, label: chipLabel(row, page) });

// ---------------------------------------------------------------------------------------------
// Client photo: the face from the photo ID in the intake folder
// ---------------------------------------------------------------------------------------------

export async function clientPhoto(matterId) {
  const docs = all("SELECT id, title, hash, doc_type, extra, file_path FROM source_items WHERE matter_id = ? AND kind = 'document' AND removed_at IS NULL AND file_path IS NOT NULL", matterId);
  // Prefer what the AI classified as a photo ID. Before the first digest, fall back to the file name.
  const doc = docs.find((d) => d.doc_type === 'photo_id') || docs.find((d) => /photo|licen[cs]e|headshot|passport/i.test(d.title));
  if (!doc) return null;
  const cacheKey = `photo:${matterId}`;
  let cached = parseJson(getSetting(cacheKey), null);
  const file = path.join(config.dataDir, 'files', String(matterId), 'client-photo.jpg');
  if (!cached || cached.hash !== doc.hash || !fs.existsSync(file)) {
    try {
      const src = documentPath(doc);
      const bytes = fs.readFileSync(src);
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const image = isJpeg ? { bytes, width: 0, height: 0 } : await largestJpeg(bytes);
      if (!image) return null;
      fs.writeFileSync(file, image.bytes);
      cached = { hash: doc.hash, source: doc.id, width: image.width, height: image.height };
      setSetting(cacheKey, JSON.stringify(cached));
    } catch {
      return null;
    }
  }
  const box = parseJson(doc.extra, {}).portrait;
  let crop = null;
  if (box && cached.width && cached.height) {
    // Square crop around the face the model located, in image pixels, with a little air around it.
    const W = cached.width;
    const H = cached.height;
    const side = Math.min(W, H, Math.max(box.w * W, box.h * H) * 1.15);
    const left = Math.max(0, Math.min(W - side, (box.x + box.w / 2) * W - side / 2));
    const top = Math.max(0, Math.min(H - side, (box.y + box.h / 2) * H - side / 2));
    crop = {
      size: `${((W / side) * 100).toFixed(1)}% ${((H / side) * 100).toFixed(1)}%`,
      position: `${W === side ? 0 : ((left / (W - side)) * 100).toFixed(1)}% ${H === side ? 0 : ((top / (H - side)) * 100).toFixed(1)}%`,
    };
  }
  return { url: `/api/photo?v=${cached.hash.slice(0, 8)}`, file, crop, source: doc.id };
}

// ---------------------------------------------------------------------------------------------
// Since you last opened
// ---------------------------------------------------------------------------------------------

export function viewWindow(matterId, choice) {
  const rows = all('SELECT opened_at FROM views WHERE matter_id = ? ORDER BY id DESC LIMIT 2', matterId).map((r) => r.opened_at);
  const inSession = rows[0] && Date.now() - Date.parse(rows[0]) < SESSION_MS;
  const previous = inSession ? rows[1] : rows[0];
  const t = today();
  const days = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 }[choice];
  if (days) return { since: new Date(Date.now() - days * 86_400_000).toISOString(), sinceDate: addDays(t, -days), label: `Last ${days} days`, previous, choice };
  if (previous) return { since: previous, sinceDate: previous.slice(0, 10), label: 'Since you last opened', previous, choice: 'last' };
  return { since: new Date(Date.now() - 14 * 86_400_000).toISOString(), sinceDate: addDays(t, -14), label: 'Last 14 days', previous: null, choice: 'last', firstVisit: true };
}

export function recordView(matterId) {
  const last = get('SELECT opened_at FROM views WHERE matter_id = ? ORDER BY id DESC LIMIT 1', matterId);
  if (last && Date.now() - Date.parse(last.opened_at) < SESSION_MS) return false;
  run('INSERT INTO views (matter_id, opened_at) VALUES (?, ?)', matterId, now());
  return true;
}

function changesSince(matterId, win) {
  const t = today();
  const firstSync = get('SELECT MIN(first_seen_at) AS m FROM source_items WHERE matter_id = ?', matterId)?.m;
  const rows = all("SELECT id, kind, title, summary, date, importance, first_seen_at, changed_at, doc_label, meta FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND kind IN ('note','communication','document','activity','task','calendar')", matterId);
  const out = [];
  for (const r of rows) {
    const meta = parseJson(r.meta, {});
    const arrived = r.first_seen_at > win.since && r.first_seen_at !== firstSync;
    const edited = r.changed_at > win.since && r.changed_at !== r.first_seen_at;
    const dated = ['note', 'communication'].includes(r.kind) && r.date && r.date > win.sinceDate && r.date <= t;
    const wentLate = r.kind === 'task' && r.date && r.date >= win.sinceDate && r.date < t && !DONE.has(meta.status);
    const tag = wentLate ? 'late' : edited ? 'changed' : arrived || dated ? 'new' : null;
    if (!tag) continue;
    out.push({ tag, text: tag === 'late' ? `${r.title} went past its due date` : r.summary || r.title, date: r.date, importance: r.importance ?? 0, chip: itemChip(r) });
  }
  out.sort((a, b) => (a.tag === 'late' ? -1 : 0) - (b.tag === 'late' ? -1 : 0) || b.importance - a.importance || String(b.date).localeCompare(String(a.date)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The page model
// ---------------------------------------------------------------------------------------------

export async function buildBrief(matterId, { since } = {}) {
  const matterRow = get("SELECT * FROM source_items WHERE matter_id = ? AND kind = 'matter' AND removed_at IS NULL", matterId);
  if (!matterRow) return null;
  const t = today();
  const meta = parseJson(matterRow.meta, {});
  const people = roster(matterId);
  const client = people.find((p) => p.is_client) || (meta.client ? { id: meta.client.id, name: meta.client.name } : null);
  const ai = loadBrief(matterId);
  const resolve = citeResolver(matterId);
  const c = ai?.case;

  // --- last time anyone actually talked to the client (Clio communications, no AI) ---
  const comms = all("SELECT id, kind, title, date, meta FROM source_items WHERE matter_id = ? AND kind = 'communication' AND removed_at IS NULL AND date IS NOT NULL ORDER BY date DESC, id DESC", matterId);
  const withClient = (r) => {
    const m = parseJson(r.meta, {});
    return [...(m.from || []), ...(m.to || [])].some((p) => client && ((p.id && p.id === client.id && p.type !== 'User') || p.name === client.name));
  };
  const lastAny = comms.find(withClient);
  const lastSpoken = comms.find((r) => withClient(r) && parseJson(r.meta, {}).type === 'phone');
  const contact = (r) => (r ? { date: r.date, days: daysBetween(r.date, t), how: parseJson(r.meta, {}).type === 'phone' ? 'Phone call' : 'Email', title: r.title, chip: itemChip({ ...r }) } : null);

  // --- needs attention: straight from Clio tasks and calendar ---
  const tasks = all("SELECT id, kind, title, body, date, meta FROM source_items WHERE matter_id = ? AND kind = 'task' AND removed_at IS NULL ORDER BY date", matterId)
    .map((r) => ({ ...r, meta: parseJson(r.meta, {}) }))
    .filter((r) => !DONE.has(r.meta.status));
  const overdue = tasks.filter((r) => r.date && r.date < t).map((r) => ({ title: r.title, detail: r.body, date: r.date, days: daysBetween(r.date, t), who: r.meta.assignee, chip: itemChip(r) }));
  const upcomingTasks = tasks.filter((r) => !r.date || r.date >= t).map((r) => ({ title: r.title, detail: r.body, date: r.date, days: r.date ? daysBetween(t, r.date) : null, type: 'task', chip: itemChip(r) }));
  const events = all("SELECT id, kind, title, body, date, meta FROM source_items WHERE matter_id = ? AND kind = 'calendar' AND removed_at IS NULL AND date >= ? ORDER BY date", matterId, t).map((r) => ({ title: r.title, detail: r.body, date: r.date, days: daysBetween(t, r.date), type: 'event', chip: itemChip(r) }));
  const upcoming = [...upcomingTasks, ...events].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));

  // --- money: sums are computed from Clio's expense entries, never by the model ---
  const expenseFacts = all("SELECT f.id, f.type, f.amount, f.contact_id, s.id AS source_id FROM facts f JOIN source_items s ON s.id = f.source_id WHERE f.matter_id = ? AND s.kind = 'activity' AND s.removed_at IS NULL AND f.type IN ('bill','firm_expense') AND f.amount IS NOT NULL", matterId);
  const firmFacts = expenseFacts.filter((f) => f.type === 'firm_expense');
  const billFacts = expenseFacts.filter((f) => f.type === 'bill');
  const sum = (list) => list.reduce((a, f) => a + Number(f.amount), 0);
  const billsByContact = new Map();
  for (const f of billFacts) {
    const k = f.contact_id || 'unassigned';
    const e = billsByContact.get(k) || { total: 0, facts: [] };
    e.total += Number(f.amount);
    e.facts.push(f.id);
    billsByContact.set(k, e);
  }

  // --- providers: the AI's reading, with Clio's own numbers laid over it ---
  const stats = visitStats(matterId);
  const shareRows = all('SELECT s.id, s.provider_key, s.created_at, s.expires_at, s.revoked_at, (SELECT COUNT(*) FROM share_opens o WHERE o.share_id = s.id) AS opens, (SELECT MAX(opened_at) FROM share_opens o WHERE o.share_id = s.id) AS last_open FROM shares s WHERE s.matter_id = ? ORDER BY s.id DESC', matterId);
  const medical = /provider|hospital|medical|surgeon|surgery|surgical|doctor|physician|therap|chiro|imaging|radiolog|clinic|neuro|ortho|emg/i;
  const base = ai?.providers?.length
    ? ai.providers
    : people.filter((p) => !p.is_client && medical.test(p.relationship || '')).map((p) => ({ contact_ids: [p.id], name: p.name, role: p.relationship, treatment_status: 'unknown', records_status: 'unknown', cites: [] }));
  const providers = base.map((p) => {
    const key = p.contact_ids[0];
    const clio = p.contact_ids.map((id) => billsByContact.get(id)).filter(Boolean);
    const visits = p.contact_ids.map((id) => stats.get(id)).filter(Boolean);
    const documented = visits.length ? { count: visits.reduce((a, v) => a + v.count, 0), first: visits.map((v) => v.first).sort()[0], last: visits.map((v) => v.last).sort().pop(), gaps: visits.flatMap((v) => v.gaps).sort((a, b) => b.days - a.days), visits: visits.flatMap((v) => [...v.where.entries()].map(([date, w]) => ({ date, source: w.source_id, page: w.page }))).sort((a, b) => a.date.localeCompare(b.date)) } : null;
    const lastVisit = [p.last_visit, documented?.last].filter(Boolean).sort().pop() || null;
    const share = shareRows.find((s) => s.provider_key === key) || null;
    return {
      ...p,
      key,
      billed: clio.length ? clio.reduce((a, e) => a + e.total, 0) : p.billed ?? null,
      billed_from: clio.length ? 'clio' : p.billed != null ? 'file' : null,
      bill_chips: resolve(clio.flatMap((e) => e.facts), 2),
      documented,
      last_visit: lastVisit,
      // Still treating, yet the records the firm holds stop long ago: worth a flag.
      records_through: documented?.last || null,
      records_stale: p.treatment_status === 'treating' && documented?.last ? daysBetween(documented.last, t) > 60 : false,
      big_gap: documented && documented.count >= 8 && documented.gaps[0] ? documented.gaps[0] : null,
      chips: resolve(p.cites, 2),
      share: share ? { id: share.id, created_at: share.created_at, expires_at: share.expires_at, revoked: Boolean(share.revoked_at), expired: share.expires_at < now(), opens: share.opens, last_open: share.last_open } : null,
    };
  });

  const billsTotal = billFacts.length ? sum(billFacts) : providers.reduce((a, p) => a + (p.billed || 0), 0) || null;
  const firmSpend = firmFacts.length ? sum(firmFacts) : null;
  const liens = (c?.liens || []).map((l) => ({ ...l, chips: resolve(l.cites, 2) }));
  const liensTotal = liens.reduce((a, l) => a + (l.amount || 0), 0);
  const cap = c?.coverage?.limit ?? null;
  const money = {
    value: c ? { ...c.case_value, chips: resolve(c.case_value.cites) } : null,
    cap,
    bills: { total: billsTotal, count: billFacts.length, providers: providers.filter((p) => p.billed).length, from: billFacts.length ? 'clio' : billsTotal ? 'file' : null, stated: c?.medical_bills_stated?.amount ?? null, note: c?.medical_bills_stated?.note || null, facts: billFacts.map((f) => f.id), chips: resolve(c?.medical_bills_stated?.cites, 1) },
    firm: { total: firmSpend, count: firmFacts.length, facts: firmFacts.map((f) => f.id) },
    liens,
    liensTotal,
    wage: c?.wage_loss?.amount != null ? { ...c.wage_loss, chips: resolve(c.wage_loss.cites, 2) } : null,
    // What is left of the cap after the lien and the firm's costs. Plain subtraction, before any fee.
    ceiling: cap != null ? cap - liensTotal - (firmSpend || 0) : null,
    offers: (c?.offers || []).map((o) => ({ ...o, chips: resolve(o.cites, 2) })),
  };

  // --- conflicts: the AI's findings plus arithmetic checks done here ---
  const conflicts = (c?.conflicts || []).map((x) => ({ ...x, chips: resolve(x.cites, 4), by: 'ai' }));
  const fieldAmounts = all("SELECT s.id, s.kind, s.title, s.date, s.meta FROM source_items s WHERE s.matter_id = ? AND s.kind = 'field' AND s.removed_at IS NULL", matterId).map((r) => ({ ...r, meta: parseJson(r.meta, {}) })).filter((r) => r.meta.amount != null && /medical|special|bill/i.test(r.title));
  if (billFacts.length) {
    const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    if (money.bills.stated != null && Math.abs(money.bills.stated - billsTotal) > 1) conflicts.push({ title: 'Bill total does not match the expense entries', detail: `The file states ${usd(money.bills.stated)}. The ${billFacts.length} medical expense entries in Clio add up to ${usd(billsTotal)}.`, severity: 'medium', chips: [...money.bills.chips, ...resolve(money.bills.facts.slice(0, 2), 2)], by: 'check' });
    for (const f of fieldAmounts) if (Math.abs(f.meta.amount - billsTotal) > 1) conflicts.push({ title: `Clio field "${f.title}" is out of date`, detail: `The field says ${usd(f.meta.amount)}. The medical expense entries add up to ${usd(billsTotal)}.`, severity: 'medium', chips: [itemChip(f), ...resolve(money.bills.facts.slice(0, 1), 1)], by: 'check' });
  }
  const stale = providers.filter((p) => p.records_stale);
  for (const p of stale) conflicts.push({ title: `${truncate(p.name, 40)}: still treating, records stop ${shortDate(p.records_through, 'always')}`, detail: `The file says the client is still being seen, but the records the firm holds end ${daysBetween(p.records_through, t)} days ago. Visits since then are undocumented.`, severity: 'medium', chips: p.chips, by: 'check' });

  // --- entries: the ten that matter, and everything ---
  const items = all("SELECT id, ref, kind, title, summary, date, importance, importance_reason, category, doc_label, page_count, digest_error, meta FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND kind IN ('note','communication','document','task','calendar','activity') ORDER BY COALESCE(date, '0000') DESC, id DESC", matterId);
  const byRef = new Map(items.map((r) => [r.ref, r]));
  const entryRow = (r, why, category) => ({ id: r.id, kind: r.kind, date: r.date, title: r.title, summary: r.summary, why: why || r.importance_reason, category: category || r.category, importance: r.importance, kindLabel: chipLabel(r).split(' · ')[0], pages: r.page_count });
  let top = (c?.top_entries || []).map((x) => (byRef.has(x.ref) ? entryRow(byRef.get(x.ref), x.why, x.category) : null)).filter(Boolean);
  if (!top.length) top = items.filter((r) => r.importance != null).sort((a, b) => b.importance - a.importance).slice(0, 10).map((r) => entryRow(r));

  // --- digest bookkeeping, shown in the footer and used for the cost answer on the form ---
  const counts = all('SELECT kind, COUNT(*) AS n FROM source_items WHERE matter_id = ? AND removed_at IS NULL GROUP BY kind', matterId);
  const cost = get('SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, SUM(cost_usd) AS usd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced FROM llm_calls WHERE matter_id = ?', matterId);
  const lastRun = get('SELECT id, status, started_at, finished_at, error, stats FROM runs WHERE matter_id = ? ORDER BY id DESC LIMIT 1', matterId);
  const lastRunCost = lastRun ? get('SELECT COUNT(*) AS calls, SUM(cost_usd) AS usd FROM llm_calls WHERE run_id = ?', lastRun.id) : null;
  const pagesRead = get("SELECT COALESCE(SUM(pages_read),0) AS n, COALESCE(SUM(page_count),0) AS total FROM source_items WHERE matter_id = ? AND kind = 'document' AND removed_at IS NULL", matterId);
  const unread = all("SELECT id, kind, title, date, doc_label, meta, digest_error FROM source_items WHERE matter_id = ? AND removed_at IS NULL AND digest_error IS NOT NULL", matterId).map((r) => ({ title: r.title, error: r.digest_error, chip: itemChip(r) }));
  const quotes = get("SELECT SUM(CASE WHEN quote_verified = 1 THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN quote_verified = 0 THEN 1 ELSE 0 END) AS bad, COUNT(*) AS n FROM facts WHERE matter_id = ? AND origin = 'ai'", matterId);

  const win = viewWindow(matterId, since);
  const incidentDate = c?.incident?.date || null;
  const anchor = incidentDate || matterRow.date;

  // Age and payer come straight from Clio contacts, never from the model.
  const dobRow = client ? get("SELECT body FROM source_items WHERE matter_id = ? AND kind = 'contact' AND clio_id = ? AND removed_at IS NULL", matterId, String(client.id)) : null;
  const dob = /Date of birth: (\d{4}-\d{2}-\d{2})/.exec(dobRow?.body || '')?.[1] || null;
  const clientAge = dob ? Math.floor(daysBetween(dob, t) / 365.25) : null;
  const payers = people.filter((p) => !p.is_client && /insur|adjust|carrier|claims/i.test(p.relationship || '')).map((p) => ({ name: p.name, role: p.relationship }));

  return {
    matterId,
    today: t,
    clientAge,
    payers,
    matter: { number: meta.display_number, description: meta.description, status: meta.status, practice_area: meta.practice_area, stage: meta.stage, opened: matterRow.date, sol: meta.sol, chip: itemChip(matterRow) },
    client: client ? { ...client, photo: await clientPhoto(matterId) } : null,
    firmUser: getSetting('firm_user'),
    hasAi: Boolean(ai),
    aiConfigured: aiConfigured(),
    partial: Boolean(ai?.partial),
    generatedAt: ai?.generated_at || null,
    caseType: c?.case_type || meta.practice_area || null,
    incident: c ? { ...c.incident, chips: resolve(c.incident.cites, 2) } : null,
    caseAgeMonths: anchor ? Math.max(0, Math.round(daysBetween(anchor, t) / 30.44)) : null,
    stageTrack: c?.stage_track || [],
    status: c ? { ...c.status, chips: resolve(c.status.cites, 2) } : null,
    deadline: c ? { ...c.limitations, chips: resolve(c.limitations.cites, 2), daysLeft: c.limitations.date && c.limitations.state !== 'suit_filed' ? daysBetween(t, c.limitations.date) : null } : meta.sol?.due ? { state: 'running', headline: 'Deadline to file', date: meta.sol.due, detail: "From the statute of limitations task in Clio.", chips: [itemChip(matterRow)], daysLeft: daysBetween(t, meta.sol.due) } : null,
    nextDate: c?.next_date?.date ? { ...c.next_date, chips: resolve(c.next_date.cites, 1), days: daysBetween(t, c.next_date.date) } : null,
    lastContact: { spoken: contact(lastSpoken), any: contact(lastAny) },
    test: c ? { fault: { ...c.fault, chips: resolve(c.fault.cites) }, coverage: { ...c.coverage, chips: resolve(c.coverage.cites) }, damages: { ...c.damages, chips: resolve(c.damages.cites) } } : null,
    injuries: (c?.injuries || []).map((i) => ({ ...i, chips: resolve(i.cites, 2) })),
    money,
    attention: { overdue, upcoming, waiting: (c?.waiting_on || []).map((w) => ({ ...w, days: w.since ? daysBetween(w.since, t) : null, chips: resolve(w.cites, 2) })) },
    changes: { ...win, items: changesSince(matterId, win) },
    conflicts,
    providers,
    pitch: (c?.pitch || []).map((p) => ({ ...p, chips: resolve(p.cites, 2) })),
    top,
    timeline: items.map((r) => entryRow(r)),
    sharing: (c?.sharing || []).map((x) => ({ ...x, chips: resolve(x.cites, 2) })),
    digest: {
      counts: Object.fromEntries(counts.map((r) => [r.kind, r.n])),
      items: counts.reduce((a, r) => a + r.n, 0),
      pagesRead: pagesRead.n,
      pagesTotal: pagesRead.total,
      lastPull: getSetting('last_pull_at'),
      cost,
      lastRun: lastRun ? { ...lastRun, stats: parseJson(lastRun.stats, {}), calls: lastRunCost?.calls || 0, usd: lastRunCost?.usd ?? null } : null,
      unread,
      quotes,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Source drawer
// ---------------------------------------------------------------------------------------------

export function sourceDetail(sourceId, { factId, page } = {}) {
  const s = get('SELECT * FROM source_items WHERE id = ?', sourceId);
  if (!s) return null;
  const meta = parseJson(s.meta, {});
  const fact = factId ? get('SELECT id, type, title, detail, page, quote, quote_verified, origin FROM facts WHERE id = ? AND source_id = ?', factId, sourceId) : null;
  const facts = all('SELECT id, type, title, detail, page, quote, quote_verified, origin FROM facts WHERE source_id = ? ORDER BY page, id', sourceId);
  const p = page || fact?.page || null;
  const pageText = s.kind === 'document' && p ? get('SELECT text FROM doc_pages WHERE source_id = ? AND page = ?', sourceId, p)?.text ?? null : null;
  return {
    id: s.id,
    kind: s.kind,
    label: chipLabel(s, p),
    title: s.title,
    date: s.date,
    dateText: s.date ? shortDate(s.date, 'always') : null,
    body: s.kind === 'document' ? pageText : s.body,
    meta,
    summary: s.summary,
    importance: s.importance,
    importance_reason: s.importance_reason,
    page: p,
    pages: s.page_count,
    pagesRead: s.pages_read,
    file: s.kind === 'document' && s.file_path ? `/api/file/${s.id}` : null,
    fileKind: parseJson(s.extra, {}).file_kind || null,
    fact,
    facts,
    error: s.digest_error,
    clio: s.clio_id,
  };
}

export function factList(ids) {
  if (!ids.length) return [];
  const rows = all(`SELECT f.id, f.type, f.title, f.detail, f.amount, f.page, f.source_id, s.kind, s.date, s.doc_label, s.meta FROM facts f JOIN source_items s ON s.id = f.source_id WHERE f.id IN (${ids.map(() => '?').join(',')}) ORDER BY s.date`, ...ids);
  return rows.map((r) => ({ id: r.id, detail: r.detail, amount: r.amount, source: r.source_id, page: r.page, label: chipLabel(r, r.page) }));
}
