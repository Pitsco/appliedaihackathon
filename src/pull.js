// Step 1 of the pipeline: read one matter out of Clio and mirror it into our own database.
// Every item is stored with a content hash, so later steps can tell exactly what is new or edited.
import fs from 'node:fs';
import path from 'node:path';
import * as clio from './clio.js';
import { config } from './config.js';
import { all, get, run, tx, now, setSetting, parseJson } from './db.js';
import { sha, isoDate, pool } from './util.js';
import { pdfPageTexts } from './pdf.js';

const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const names = (list) => (Array.isArray(list) ? list : list ? [list] : []).map((p) => ({ id: p?.id != null ? String(p.id) : null, type: p?.type || null, name: p?.name || p?.identifier || 'Unknown' }));

export async function resolveMatterId() {
  if (config.clio.matterId) return config.clio.matterId;
  const matters = await clio.listMatters();
  if (!matters.length) throw new Error('This Clio account has no matters yet. Run the hackathon setup app first, then sync again.');
  const q = config.clio.matterQuery.toLowerCase();
  const hit = q
    ? matters.find((m) => [m.display_number, m.description, m.client?.name].some((v) => String(v || '').toLowerCase().includes(q)))
    : null;
  const newest = [...matters].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
  return String((hit || newest).id);
}

// ---------------------------------------------------------------------------------------------
// Clio JSON -> one uniform shape: { ref, kind, clio_id, title, body, date, meta }
// ---------------------------------------------------------------------------------------------

function fieldValue(cf) {
  const v = cf.value;
  if (v == null || v === '') return '';
  if (cf.picklist_option?.option) return String(cf.picklist_option.option);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return String(v.name || v.option || v.value || JSON.stringify(v));
  if (cf.field_type === 'currency' && Number.isFinite(Number(v))) return money(v);
  return String(v);
}

function normMatter(m) {
  const lines = [];
  const add = (label, value) => value && lines.push(`${label}: ${value}`);
  add('Matter', m.display_number);
  add('Description', m.description);
  add('Status', m.status);
  add('Practice area', m.practice_area?.name);
  add('Matter stage in Clio', m.matter_stage?.name);
  add('Opened', isoDate(m.open_date));
  add('Closed', isoDate(m.close_date));
  add('Client', m.client?.name);
  add('Responsible attorney', m.responsible_attorney?.name);
  const sol = m.statute_of_limitations;
  if (sol?.due_at) add('Statute of limitations task in Clio', `${isoDate(sol.due_at)}${sol.status ? ` (${sol.status})` : ''}`);
  return {
    ref: `matter:${m.id}`,
    kind: 'matter',
    clio_id: String(m.id),
    title: [m.display_number, m.description].filter(Boolean).join(' · ') || `Matter ${m.id}`,
    body: lines.join('\n'),
    date: isoDate(m.open_date),
    meta: {
      display_number: m.display_number || null,
      description: m.description || null,
      status: m.status || null,
      practice_area: m.practice_area?.name || null,
      stage: m.matter_stage?.name || null,
      client: m.client ? { id: String(m.client.id), name: m.client.name } : null,
      sol: sol?.due_at ? { due: isoDate(sol.due_at), status: sol.status || null } : null,
    },
  };
}

const normField = (cf) => ({
  ref: `field:${cf.id}`,
  kind: 'field',
  clio_id: String(cf.id),
  title: cf.field_name || 'Custom field',
  body: fieldValue(cf),
  date: null,
  meta: { field_type: cf.field_type || null, amount: cf.field_type === 'currency' && Number.isFinite(Number(cf.value)) ? Number(cf.value) : null },
});

function normContact(c, isClient) {
  const a = (c.addresses || []).find((x) => x.primary) || (c.addresses || [])[0] || null;
  const address = a ? { street: a.street || null, city: a.city || null, state: a.province || null, zip: a.postal_code || null, country: a.country || null } : null;
  const relationship = isClient ? 'Client' : c.relationship?.description || null;
  const addressLine = address ? [address.street, address.city, address.state, address.zip].filter(Boolean).join(', ') : '';
  return {
    ref: `contact:${c.id}`,
    kind: 'contact',
    clio_id: String(c.id),
    title: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || `Contact ${c.id}`,
    body: [relationship && `Relationship: ${relationship}`, c.type && `Type: ${c.type}`, c.title && `Title: ${c.title}`, c.primary_email_address && `Email: ${c.primary_email_address}`, c.primary_phone_number && `Phone: ${c.primary_phone_number}`, addressLine && `Address: ${addressLine}`, c.date_of_birth && `Date of birth: ${isoDate(c.date_of_birth)}`]
      .filter(Boolean)
      .join('\n'),
    date: null,
    meta: {
      relationship,
      is_client: Boolean(isClient),
      type: c.type || null,
      prefix: c.prefix || c.title || null,
      email: c.primary_email_address || null,
      phone: c.primary_phone_number || null,
      address,
      company: c.company?.name || null,
    },
  };
}

const normNote = (n) => ({
  ref: `note:${n.id}`,
  kind: 'note',
  clio_id: String(n.id),
  title: n.subject || 'Note',
  body: n.detail || '',
  date: isoDate(n.date || n.created_at),
  meta: { author: n.author?.name || null },
});

function normCommunication(c) {
  const type = /phone/i.test(c.type || '') ? 'phone' : /email/i.test(c.type || '') ? 'email' : String(c.type || 'other').toLowerCase();
  return {
    ref: `comm:${c.id}`,
    kind: 'communication',
    clio_id: String(c.id),
    title: c.subject || (type === 'phone' ? 'Phone call' : 'Message'),
    body: c.body || '',
    date: isoDate(c.date || c.received_at || c.created_at),
    meta: { type, from: names(c.senders), to: names(c.receivers), logged_by: c.user?.name || null },
  };
}

const normTask = (t) => ({
  ref: `task:${t.id}`,
  kind: 'task',
  clio_id: String(t.id),
  title: t.name || 'Task',
  body: t.description || '',
  date: isoDate(t.due_at),
  meta: {
    status: String(t.status || '').toLowerCase() || null,
    priority: t.priority || null,
    completed_at: isoDate(t.completed_at),
    assignee: t.assignee?.name || null,
    task_type: t.task_type?.name || null,
    is_sol: Boolean(t.statute_of_limitations),
  },
});

const normEvent = (e) => ({
  ref: `event:${e.id}`,
  kind: 'calendar',
  clio_id: String(e.id),
  title: e.summary || 'Calendar entry',
  body: e.description || '',
  date: isoDate(e.start_at),
  meta: { start_at: e.start_at || null, end_at: e.end_at || null, all_day: Boolean(e.all_day), location: e.location || null },
});

function normActivity(a) {
  const computed = Number(a.price || 0) * Number(a.quantity || 0);
  // Clio keeps billable and non-billable totals apart. The entry's own value is whichever is populated.
  const amount = [a.total, a.non_billable_total, computed].map(Number).find((n) => Number.isFinite(n) && n > 0) ?? 0;
  const note = a.note || '';
  return {
    ref: `activity:${a.id}`,
    kind: 'activity',
    clio_id: String(a.id),
    title: note.split('\n')[0].slice(0, 140) || a.type || 'Activity',
    body: note,
    date: isoDate(a.date),
    meta: {
      type: a.type || null,
      amount,
      non_billable: Boolean(a.non_billable) || (!Number(a.total) && Number(a.non_billable_total) > 0),
      category: a.expense_category?.name || null,
      vendor: a.vendor?.name || null,
    },
  };
}

const normDocument = (d) => ({
  ref: `doc:${d.id}`,
  kind: 'document',
  clio_id: String(d.id),
  title: d.name || d.filename || `Document ${d.id}`,
  body: '',
  date: isoDate(d.received_at || d.created_at),
  meta: {
    filename: d.latest_document_version?.filename || d.filename || d.name || null,
    content_type: d.latest_document_version?.content_type || d.content_type || null,
    size: d.latest_document_version?.size ?? d.size ?? null,
    folder: d.parent?.name || null,
    version: d.latest_document_version?.id != null ? String(d.latest_document_version.id) : null,
  },
});

// ---------------------------------------------------------------------------------------------
// Upsert with change detection
// ---------------------------------------------------------------------------------------------

function upsert(matterId, item, seenAt) {
  const meta = JSON.stringify(item.meta ?? {});
  const hash = sha([item.kind, item.title ?? '', item.body ?? '', item.date ?? '', meta]);
  const row = get('SELECT id, hash FROM source_items WHERE matter_id = ? AND ref = ?', matterId, item.ref);
  if (!row) {
    const r = run(
      'INSERT INTO source_items (matter_id, ref, kind, clio_id, title, body, date, meta, hash, first_seen_at, changed_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      matterId, item.ref, item.kind, item.clio_id, item.title, item.body, item.date, meta, hash, seenAt, seenAt, seenAt,
    );
    return { id: Number(r.lastInsertRowid), state: 'new' };
  }
  if (row.hash !== hash) {
    run('UPDATE source_items SET title = ?, body = ?, date = ?, meta = ?, hash = ?, changed_at = ?, last_seen_at = ?, removed_at = NULL WHERE id = ?', item.title, item.body, item.date, meta, hash, seenAt, seenAt, row.id);
    return { id: row.id, state: 'changed' };
  }
  run('UPDATE source_items SET last_seen_at = ?, removed_at = NULL WHERE id = ?', seenAt, row.id);
  return { id: row.id, state: 'same' };
}

function retire(matterId, kind, seenAt) {
  const gone = all('SELECT id FROM source_items WHERE matter_id = ? AND kind = ? AND last_seen_at < ? AND removed_at IS NULL', matterId, kind, seenAt);
  for (const { id } of gone) {
    run('UPDATE source_items SET removed_at = ? WHERE id = ?', seenAt, id);
    run('DELETE FROM facts WHERE source_id = ?', id);
  }
  return gone.length;
}

/** Facts that come straight from structured Clio fields need no AI. */
function writeStructuredFacts(matterId) {
  const items = all("SELECT id, kind, clio_id, title, body, date, meta, hash FROM source_items WHERE matter_id = ? AND kind IN ('matter','field','contact') AND removed_at IS NULL AND (digested_hash IS NULL OR digested_hash != hash)", matterId);
  const insert = (item, f) =>
    run('INSERT INTO facts (matter_id, source_id, origin, page, type, title, detail, date, amount, contact_id, status, quote, quote_verified, sensitivity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', matterId, item.id, 'clio', null, f.type, f.title, f.detail, f.date ?? null, f.amount ?? null, f.contact_id ?? null, null, f.quote ?? null, 1, f.sensitivity || 'administrative');
  tx(() => {
    for (const item of items) {
      const meta = parseJson(item.meta, {});
      run('DELETE FROM facts WHERE source_id = ?', item.id);
      if (item.kind === 'field' && item.body) {
        insert(item, { type: 'field', title: item.title, detail: `Clio field "${item.title}": ${item.body}`, amount: meta.amount, quote: item.body.slice(0, 240), sensitivity: 'strategy' });
      } else if (item.kind === 'contact') {
        const where = meta.address ? [meta.address.city, meta.address.state].filter(Boolean).join(', ') : '';
        insert(item, { type: 'party', title: item.title, detail: `${item.title}: ${meta.relationship || 'related contact'}${where ? `. Address on file: ${where}` : ''}.`, contact_id: item.clio_id, quote: (meta.relationship || '').slice(0, 240) });
      } else if (item.kind === 'matter') {
        insert(item, { type: 'matter', title: 'Matter record', detail: item.body.replace(/\n/g, '; '), date: item.date, quote: (meta.description || '').slice(0, 240) });
        if (meta.sol?.due) insert(item, { type: 'deadline', title: 'Statute of limitations task', detail: `Clio's statute of limitations task is due ${meta.sol.due}${meta.sol.status ? ` (${meta.sol.status})` : ''}.`, date: meta.sol.due, quote: meta.sol.due });
      }
      run('UPDATE source_items SET digested_hash = hash, digested_at = ?, digest_error = NULL WHERE id = ?', now(), item.id);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Documents: download once, split into pages
// ---------------------------------------------------------------------------------------------

const absFile = (rel) => path.join(config.dataDir, rel);
export const documentPath = (row) => (row?.file_path ? absFile(row.file_path) : null);

function fileKind(bytes, meta) {
  const head = bytes.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return { kind: 'pdf', ext: '.pdf' };
  if (head[0] === 0xff && head[1] === 0xd8) return { kind: 'image', ext: '.jpg', media: 'image/jpeg' };
  if (head.subarray(1, 4).toString('latin1') === 'PNG') return { kind: 'image', ext: '.png', media: 'image/png' };
  const name = String(meta.filename || '').toLowerCase();
  const type = String(meta.content_type || '').toLowerCase();
  if (type.startsWith('text/') || /\.(txt|md|csv|eml)$/.test(name)) return { kind: 'text', ext: path.extname(name) || '.txt' };
  return { kind: 'other', ext: path.extname(name) || '.bin' };
}

async function fetchDocument(matterId, id, state) {
  const row = get('SELECT id, clio_id, meta, file_path, page_count FROM source_items WHERE id = ?', id);
  const have = row.file_path && fs.existsSync(absFile(row.file_path)) && row.page_count != null;
  if (state === 'same' && have) return false;
  const meta = parseJson(row.meta, {});
  const { bytes } = await clio.downloadDocument(row.clio_id);
  const kind = fileKind(bytes, meta);
  const rel = path.join('files', String(matterId), `${row.clio_id}${kind.ext}`);
  fs.mkdirSync(path.dirname(absFile(rel)), { recursive: true });
  fs.writeFileSync(absFile(rel), bytes);

  let pages = [];
  let note = null;
  if (kind.kind === 'pdf') {
    try {
      pages = await pdfPageTexts(bytes);
    } catch (err) {
      note = `Could not read this PDF's text layer (${err.message}).`;
    }
  } else if (kind.kind === 'text') pages = [bytes.toString('utf8')];
  else if (kind.kind === 'image') pages = [''];
  else note = 'Unsupported file type. PDFs, images and plain text are read.';

  tx(() => {
    run('DELETE FROM doc_pages WHERE source_id = ?', id);
    pages.forEach((text, i) => run('INSERT INTO doc_pages (source_id, page, text) VALUES (?,?,?)', id, i + 1, text));
    run('UPDATE source_items SET file_path = ?, page_count = ?, extra = ?, digest_error = ? WHERE id = ?', rel, pages.length, JSON.stringify({ file_kind: kind.kind, media: kind.media || null }), note, id);
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// The pull
// ---------------------------------------------------------------------------------------------

export async function pullMatter({ onProgress = () => {} } = {}) {
  const seenAt = now();
  const warnings = [];
  const counts = {};

  onProgress('Connecting to Clio');
  try {
    const me = await clio.whoAmI();
    if (me?.name) setSetting('firm_user', me.name);
  } catch (err) {
    if (err.status === 401) throw err;
    warnings.push(`Could not read the signed-in user: ${err.message}`);
  }

  const matterId = await resolveMatterId();
  const matter = await clio.getMatter(matterId);
  if (!matter) throw new Error(`Clio returned no matter for id ${matterId}.`);
  setSetting('matter_id', String(matter.id));
  const mid = String(matter.id);

  const tally = (kind, state) => {
    counts[kind] ??= { total: 0, new: 0, changed: 0 };
    counts[kind].total++;
    if (state !== 'same') counts[kind][state]++;
  };
  const store = (kind, items) => {
    tx(() => {
      for (const item of items) tally(kind, upsert(mid, item, seenAt).state);
    });
    retire(mid, kind, seenAt);
  };

  store('matter', [normMatter(matter)]);
  store('field', (matter.custom_field_values || []).filter((cf) => cf && cf.field_name).map(normField));

  // Contacts: the client plus everyone related to the matter.
  onProgress('Reading contacts');
  try {
    const related = await clio.listRelatedContacts(mid);
    const byId = new Map(related.map((c) => [String(c.id), c]));
    const clientId = matter.client?.id != null ? String(matter.client.id) : null;
    if (clientId) {
      let client = byId.get(clientId) || matter.client;
      try {
        client = { ...client, ...(await clio.getContact(clientId)) };
      } catch {
        /* the name from the matter is enough */
      }
      byId.set(clientId, client);
    }
    store('contact', [...byId.values()].map((c) => normContact(c, String(c.id) === clientId || c.is_matter_client === true)));
  } catch (err) {
    if (err.status === 401) throw err;
    warnings.push(`Contacts: ${err.message}`);
  }

  const kinds = [
    ['note', 'Reading notes', clio.listNotes, normNote],
    ['communication', 'Reading emails and calls', clio.listCommunications, normCommunication],
    ['task', 'Reading tasks', clio.listTasks, normTask],
    ['calendar', 'Reading the calendar', clio.listCalendarEntries, normEvent],
    ['activity', 'Reading case expenses', clio.listActivities, normActivity],
  ];
  for (const [kind, label, fetchAll, norm] of kinds) {
    onProgress(label);
    try {
      store(kind, (await fetchAll(mid)).map(norm));
    } catch (err) {
      if (err.status === 401) throw err;
      warnings.push(`${label.replace('Reading ', '')}: ${err.message}`);
    }
  }

  onProgress('Listing documents');
  try {
    const docs = (await clio.listDocuments(mid)).map(normDocument);
    const states = new Map();
    tx(() => {
      for (const item of docs) {
        const r = upsert(mid, item, seenAt);
        tally('document', r.state);
        states.set(r.id, r.state);
      }
    });
    retire(mid, 'document', seenAt);
    let done = 0;
    await pool([...states.entries()], 3, async ([id, state]) => {
      try {
        await fetchDocument(mid, id, state);
      } catch (err) {
        run('UPDATE source_items SET digest_error = ? WHERE id = ?', `Download failed: ${err.message}`, id);
        warnings.push(`Document ${id}: ${err.message}`);
      }
      onProgress(`Downloading documents ${++done}/${states.size}`);
    });
  } catch (err) {
    if (err.status === 401) throw err;
    warnings.push(`Documents: ${err.message}`);
  }

  writeStructuredFacts(mid);
  warnings.push(...clio.takeFieldNotes());
  setSetting('last_pull_at', seenAt);
  return { matterId: mid, counts, warnings };
}

/** People and organisations on the matter, as passed to every AI call and used to label facts. */
export function roster(matterId) {
  return all("SELECT clio_id, title, meta FROM source_items WHERE matter_id = ? AND kind = 'contact' AND removed_at IS NULL ORDER BY id", matterId).map((r) => {
    const meta = parseJson(r.meta, {});
    return { id: r.clio_id, name: r.title, relationship: meta.relationship || null, is_client: Boolean(meta.is_client), type: meta.type || null, email: meta.email || null, phone: meta.phone || null, address: meta.address || null };
  });
}
