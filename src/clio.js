// Clio Manage API v4 client. READ-ONLY BY CONSTRUCTION.
//
// Every request to /api/v4 goes through request(), which hard-codes method GET.
// There is no code path here that can create, update or delete case data in Clio.
// The only POST in this file is the OAuth token exchange at /oauth/token, which is
// authentication, not case data.
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { sleep } from './util.js';

export class ClioError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'ClioError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const base = () => config.clio.baseUrl;

export const clioToken = () => config.clio.accessToken || getSetting('clio_access_token') || '';
export const clioConfigured = () => Boolean(clioToken());
export const oauthAvailable = () => Boolean(config.clio.clientId && config.clio.clientSecret);

// ---------------------------------------------------------------------------------------------
// OAuth (authorization code flow)
// ---------------------------------------------------------------------------------------------

export function authorizeUrl(state) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.clio.clientId,
    redirect_uri: config.clio.redirectUri,
    state,
  });
  return `${base()}/oauth/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${base()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.clio.clientId, client_secret: config.clio.clientSecret, ...params }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok || !body?.access_token) {
    throw new ClioError(`Clio refused the token request (${res.status}). Check the client id, secret and redirect URI.`, {
      status: res.status,
      body,
    });
  }
  setSetting('clio_access_token', body.access_token);
  if (body.refresh_token) setSetting('clio_refresh_token', body.refresh_token);
  return body;
}

export const exchangeCode = (code) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.clio.redirectUri });

async function refreshAccessToken() {
  const refresh = getSetting('clio_refresh_token');
  if (!refresh || !oauthAvailable() || config.clio.accessToken) return false;
  try {
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// GET with retries
// ---------------------------------------------------------------------------------------------

function explain(status, body, url) {
  const detail = body?.error?.message || (typeof body === 'string' ? body.slice(0, 200) : '');
  const where = new URL(url).pathname;
  if (status === 401) {
    return 'Clio rejected the access token (401). Set a fresh CLIO_ACCESS_TOKEN in .env, or reconnect at /clio/login.';
  }
  if (status === 403) {
    return `Clio says this token may not read ${where} (403). Enable read access for it on your developer app. ${detail}`;
  }
  if (status === 404) return `Clio has nothing at ${where} (404). ${detail}`;
  return `Clio returned ${status} for ${where}. ${detail}`.trim();
}

async function request(url, { manualRedirect = false } = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${clioToken()}`, Accept: 'application/json' },
        redirect: manualRedirect ? 'manual' : 'follow',
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      if (attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new ClioError(`Could not reach Clio at ${new URL(url).host} (${err.cause?.code || err.message}).`, { url });
    }
    if (res.status === 429 && attempt < 8) {
      const wait = Number(res.headers.get('retry-after')) || 10;
      await sleep((Math.min(wait, 60) + 1) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 401 && !refreshed && (await refreshAccessToken())) {
      refreshed = true;
      continue;
    }
    return res;
  }
}

async function getJson(url) {
  const res = await request(url);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ClioError(explain(res.status, body, url), { status: res.status, body, url });
  return body;
}

function apiUrl(path, params = {}) {
  const url = new URL(`${base()}/api/v4/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Field selection that survives a wrong guess
// ---------------------------------------------------------------------------------------------
// Clio only returns the fields you name, and answers 400 if you name one it does not know.
// Rather than let one bad name take down a whole pull, we drop the field Clio complains
// about and try again, then fall back to a minimal list.

const splitTop = (fields) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of fields) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

export function dropFields(fields, message) {
  const quoted = [...String(message).matchAll(/['"`]([a-z_][a-z0-9_.]*)['"`]|:\s*([a-z_][a-z0-9_.]*)/gi)]
    .map((m) => (m[1] || m[2]).split('.').pop())
    .filter(Boolean);
  if (!quoted.length) return null;
  const bad = new Set(quoted);
  let changed = false;
  const kept = [];
  for (const token of splitTop(fields)) {
    const m = /^([a-z_0-9]+)\{(.*)\}$/i.exec(token);
    if (m) {
      if (bad.has(m[1])) {
        changed = true;
        continue;
      }
      const inner = m[2].split(',').filter((f) => !bad.has(f));
      if (inner.length !== m[2].split(',').length) changed = true;
      if (inner.length) kept.push(`${m[1]}{${inner.join(',')}}`);
    } else if (bad.has(token)) changed = true;
    else kept.push(token);
  }
  return changed && kept.length ? kept.join(',') : null;
}

const fieldNotes = [];
export const takeFieldNotes = () => fieldNotes.splice(0);

async function getWithFields(path, params, [preferred, safe]) {
  let fields = preferred;
  for (let i = 0; i < 12; i++) {
    try {
      return await getJson(apiUrl(path, { ...params, fields }));
    } catch (err) {
      if (!(err instanceof ClioError) || ![400, 422].includes(err.status)) throw err;
      const message = err.body?.error?.message || '';
      const next = dropFields(fields, message) || (fields !== safe ? safe : null);
      if (!next || next === fields) throw err;
      fieldNotes.push(`${path}: Clio rejected a field ("${message.slice(0, 120)}"), retried with fewer fields.`);
      fields = next;
    }
  }
  throw new ClioError(`Clio kept rejecting the fields for ${path}.`);
}

async function listAll(path, params, fieldSet) {
  let page = await getWithFields(path, { limit: 200, ...params }, fieldSet);
  const rows = [...(page?.data || [])];
  let next = page?.meta?.paging?.next;
  let guard = 0;
  while (next && guard++ < 200) {
    page = await getJson(next);
    rows.push(...(page?.data || []));
    next = page?.meta?.paging?.next;
  }
  return rows;
}

// [preferred, safe] field lists per resource.
const FIELDS = {
  me: ['id,name,email', 'id,name'],
  matterList: ['id,display_number,description,status,updated_at,client{id,name}', 'id,display_number,description'],
  matter: [
    'id,etag,display_number,description,status,open_date,close_date,pending_date,created_at,updated_at,' +
      'client{id,name,first_name,last_name,type,primary_email_address,primary_phone_number},' +
      'practice_area{id,name},matter_stage{id,name},responsible_attorney{id,name},originating_attorney{id,name},' +
      'statute_of_limitations{id,name,status,due_at,description},' +
      'custom_field_values{id,field_name,field_type,value,picklist_option}',
    'id,display_number,description,status,open_date,client{id,name},custom_field_values{id,field_name,field_type,value}',
  ],
  contact: [
    'id,etag,name,first_name,last_name,type,prefix,title,date_of_birth,primary_email_address,primary_phone_number,' +
      'addresses{name,street,city,province,postal_code,country,primary},created_at,updated_at',
    'id,name,type',
  ],
  relatedContact: [
    'id,etag,name,first_name,last_name,type,prefix,title,primary_email_address,primary_phone_number,is_matter_client,' +
      'company{id,name},relationship{id,description},addresses{name,street,city,province,postal_code,country,primary},' +
      'created_at,updated_at',
    'id,name,type,is_matter_client,relationship{id,description}',
  ],
  note: ['id,etag,type,subject,detail,date,created_at,updated_at,author{id,name}', 'id,subject,detail,date'],
  communication: [
    'id,etag,type,subject,body,date,received_at,created_at,updated_at,' +
      'senders{id,type,name,identifier},receivers{id,type,name,identifier},user{id,name}',
    'id,type,subject,body,date,senders{id,type,name},receivers{id,type,name}',
  ],
  task: [
    'id,etag,name,description,status,priority,due_at,completed_at,statute_of_limitations,created_at,updated_at,' +
      'assignee{id,name,type},assigner{id,name},task_type{id,name}',
    'id,name,description,status,due_at',
  ],
  calendarEntry: [
    'id,etag,summary,description,location,start_at,end_at,all_day,created_at,updated_at,calendar_owner{id,name,type}',
    'id,summary,description,start_at,end_at,all_day',
  ],
  activity: [
    'id,etag,type,date,quantity,price,total,non_billable,non_billable_total,billed,note,created_at,updated_at,' +
      'expense_category{id,name},vendor{id,name},user{id,name}',
    'id,type,date,quantity,price,total,note',
  ],
  document: [
    'id,etag,name,filename,content_type,size,created_at,updated_at,received_at,parent{id,name,type},' +
      'latest_document_version{id,size,content_type,filename,fully_uploaded}',
    'id,name,content_type,created_at,updated_at,parent{id,name}',
  ],
  folder: ['id,name,parent{id,name}', 'id,name'],
};

// ---------------------------------------------------------------------------------------------
// Resources. All GET.
// ---------------------------------------------------------------------------------------------

export const whoAmI = async () => (await getWithFields('users/who_am_i.json', {}, FIELDS.me))?.data ?? null;

export const listMatters = () => listAll('matters.json', {}, FIELDS.matterList);

export const getMatter = async (id) => (await getWithFields(`matters/${id}.json`, {}, FIELDS.matter))?.data ?? null;

export const getContact = async (id) => (await getWithFields(`contacts/${id}.json`, {}, FIELDS.contact))?.data ?? null;

export async function listRelatedContacts(matterId) {
  try {
    return await listAll(`matters/${matterId}/related_contacts.json`, {}, FIELDS.relatedContact);
  } catch (err) {
    if (!(err instanceof ClioError) || err.status !== 404) throw err;
    // Older accounts expose the same data through relationships.
    const rels = await listAll('relationships.json', { matter_id: matterId }, [
      'id,description,contact{id,name,type,first_name,last_name,primary_email_address,primary_phone_number}',
      'id,description,contact{id,name,type}',
    ]);
    return rels.filter((r) => r.contact).map((r) => ({ ...r.contact, relationship: { id: r.id, description: r.description } }));
  }
}

export const listNotes = (matterId) => listAll('notes.json', { type: 'Matter', matter_id: matterId }, FIELDS.note);
export const listCommunications = (matterId) => listAll('communications.json', { matter_id: matterId }, FIELDS.communication);
export const listTasks = (matterId) => listAll('tasks.json', { matter_id: matterId }, FIELDS.task);
export const listCalendarEntries = (matterId) => listAll('calendar_entries.json', { matter_id: matterId }, FIELDS.calendarEntry);
export const listActivities = (matterId) => listAll('activities.json', { matter_id: matterId }, FIELDS.activity);

export async function listDocuments(matterId) {
  const docs = await listAll('documents.json', { matter_id: matterId }, FIELDS.document);
  if (docs.length) return docs;
  // Some accounts only return documents when asked folder by folder.
  const seen = new Map();
  try {
    const folders = await listAll('folders.json', { matter_id: matterId }, FIELDS.folder);
    for (const folder of folders) {
      const inside = await listAll('documents.json', { parent_id: folder.id }, FIELDS.document);
      for (const d of inside) seen.set(d.id, { ...d, parent: d.parent || folder });
    }
  } catch {
    /* folder listing is best effort */
  }
  return [...seen.values()];
}

/** Download one document. Clio answers 303 with a short-lived signed URL, which must be fetched without our token. */
export async function downloadDocument(id) {
  const url = apiUrl(`documents/${id}/download.json`);
  let res = await request(url, { manualRedirect: true });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location');
    if (!location) throw new ClioError(`Clio redirected the download of document ${id} without a location.`, { url });
    res = await fetch(new URL(location, url), { method: 'GET', signal: AbortSignal.timeout(120_000) });
  }
  if (!res.ok) throw new ClioError(`Could not download document ${id} (${res.status}).`, { status: res.status, url });
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}
