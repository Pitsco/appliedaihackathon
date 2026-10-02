// The web server. Plain node:http, no framework, no build step.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, aiConfigured, ROOT } from './config.js';
import { get, getSetting, setSetting, parseJson } from './db.js';
import * as clio from './clio.js';
import { startSync, syncStatus } from './pipeline.js';
import { activeMatterId, buildBrief, sourceDetail, factList, recordView, clientPhoto } from './brief.js';
import { shareProposal, createShare, revokeShare, listShares, openShare } from './shares.js';
import { documentPath } from './pull.js';
import { attorneyPage } from './views/attorney.js';
import { sharePage, providerPage, providerCard } from './views/share.js';
import { setupPage } from './views/setup.js';

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
};
const html = (res, body, status = 200) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8' });
const json = (res, body, status = 200) => send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
const redirect = (res, to) => send(res, 302, '', { Location: to });

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Request too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

function file(res, abs, { inline = true, name } = {}) {
  if (!abs || !fs.existsSync(abs)) return send(res, 404, 'Not found');
  const type = TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Content-Length': fs.statSync(abs).size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}${name ? `; filename="${name.replace(/[^\w.\- ]/g, '_')}"` : ''}` });
  fs.createReadStream(abs).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  // ---- static ----
  if (method === 'GET' && p.startsWith('/public/')) {
    const abs = path.join(ROOT, 'public', path.basename(p));
    return file(res, abs);
  }

  // ---- the provider's side: one route, one snapshot, nothing else ----
  const provider = /^\/p\/([A-Za-z0-9_-]{16,})$/.exec(p);
  if (method === 'GET' && provider) return html(res, providerPage(openShare(provider[1], req.headers['user-agent'])));

  // ---- Clio OAuth ----
  if (method === 'GET' && p === '/clio/login') {
    if (!clio.oauthAvailable()) return html(res, 'Set CLIO_CLIENT_ID and CLIO_CLIENT_SECRET in .env first.', 400);
    const state = crypto.randomBytes(16).toString('hex');
    setSetting('clio_oauth_state', state);
    return redirect(res, clio.authorizeUrl(state));
  }
  if (method === 'GET' && p === '/clio/callback') {
    if (url.searchParams.get('error')) return html(res, `Clio did not authorise the app: ${url.searchParams.get('error')}. <a href="/">Back</a>`, 400);
    if (url.searchParams.get('state') !== getSetting('clio_oauth_state')) return html(res, 'That sign-in link is stale. <a href="/clio/login">Try again</a>.', 400);
    await clio.exchangeCode(url.searchParams.get('code'));
    return redirect(res, '/');
  }

  // ---- sync ----
  if (method === 'GET' && p === '/api/status') return json(res, syncStatus());
  if (method === 'POST' && p === '/api/sync') {
    const body = await readJson(req).catch(() => ({}));
    if (!clio.clioConfigured()) return json(res, { error: 'Clio is not connected yet.' }, 400);
    startSync({ rebuild: Boolean(body.rebuild), pullOnly: Boolean(body.pullOnly) });
    return json(res, syncStatus());
  }

  const matterId = activeMatterId();
  const synced = matterId && get("SELECT 1 AS x FROM source_items WHERE matter_id = ? AND kind = 'matter'", matterId);

  // ---- pages ----
  if (method === 'GET' && p === '/') {
    if (!synced) return html(res, setupPage({ clio: clio.clioConfigured(), oauth: clio.oauthAvailable(), ai: aiConfigured(), status: syncStatus(), baseUrl: config.clio.baseUrl }));
    const model = await buildBrief(matterId, { since: url.searchParams.get('since') || undefined });
    return html(res, attorneyPage(model, syncStatus()));
  }
  if (method === 'GET' && (p === '/share' || p === '/share/preview')) {
    if (!synced) return redirect(res, '/');
    const model = await buildBrief(matterId);
    const key = url.searchParams.get('provider') || model.providers[0]?.key;
    const proposal = model.providers.length ? shareProposal(model, key) || shareProposal(model, model.providers[0].key) : null;
    return html(res, sharePage(model, { proposal, shares: listShares(matterId), status: syncStatus(), mode: p.endsWith('preview') ? 'preview' : 'review' }));
  }

  if (!synced && p.startsWith('/api/')) return json(res, { error: 'No matter has been pulled yet.' }, 400);

  // ---- data for the source panel ----
  const source = /^\/api\/source\/(\d+)$/.exec(p);
  if (method === 'GET' && source) {
    const detail = sourceDetail(Number(source[1]), { factId: Number(url.searchParams.get('fact')) || null, page: Number(url.searchParams.get('page')) || null });
    return detail ? json(res, detail) : json(res, { error: 'Not found' }, 404);
  }
  if (method === 'GET' && p === '/api/facts') {
    const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter(Number.isInteger).slice(0, 200);
    return json(res, factList(ids));
  }
  const doc = /^\/api\/file\/(\d+)$/.exec(p);
  if (method === 'GET' && doc) {
    const row = get("SELECT title, file_path FROM source_items WHERE id = ? AND kind = 'document'", Number(doc[1]));
    return file(res, documentPath(row), { name: row?.title });
  }
  if (method === 'GET' && p === '/api/photo') {
    const photo = await clientPhoto(matterId);
    return photo ? file(res, photo.file) : send(res, 404, 'No photo');
  }
  if (method === 'POST' && p === '/api/view') return json(res, { recorded: recordView(matterId) });

  // ---- shares ----
  if (method === 'POST' && p === '/api/shares') {
    const body = await readJson(req);
    const model = await buildBrief(matterId);
    try {
      const share = createShare(model, String(body.provider || ''), Array.isArray(body.keys) ? body.keys.map(String) : [], { days: body.days, note: body.note });
      return json(res, { id: share.id, url: `${url.origin}${share.path}`, expires_at: share.expires_at });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }
  const revoke = /^\/api\/shares\/(\d+)\/revoke$/.exec(p);
  if (method === 'POST' && revoke) return json(res, { revoked: revokeShare(Number(revoke[1])) });
  if (method === 'POST' && p === '/api/preview') {
    const body = await readJson(req);
    return html(res, providerCard(body, { preview: true }));
  }

  return html(res, 'Not found. <a href="/">Back to the brief</a>', 404);
}

export function start() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) json(res, { error: err.message }, 500);
      else res.end();
    });
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Stop the other program, or set PORT=3001 in .env and start again.\n`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(config.port, () => {
    console.log(`\nCaseBrief is running at http://localhost:${config.port}`);
    console.log(`  Clio: ${clio.clioConfigured() ? `connected (${config.clio.baseUrl})` : 'not connected yet'}`);
    console.log(`  AI:   ${aiConfigured() ? `${config.ai.extractModel} reads, ${config.ai.synthModel} writes the brief` : 'no key set'}\n`);
  });
  return server;
}
