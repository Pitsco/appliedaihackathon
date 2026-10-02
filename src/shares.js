// Sharing with a treating provider.
//
// The attorney approves a list of items for one provider. We freeze exactly those items into a
// snapshot and hand out an unguessable link. The provider page renders the snapshot and nothing
// else: it has no route into the firm's facts, documents or notes. Only a hash of the token is
// stored, links expire, can be revoked, and every open is logged.
import crypto from 'node:crypto';
import { all, get, run, now, parseJson } from './db.js';
import { config } from './config.js';
import { sha } from './util.js';
import { shortDate } from './brief.js';

const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Everything the attorney can choose from for one provider, each item with a proposed decision and the reason for it. */
export function shareProposal(model, providerKey) {
  const p = model.providers.find((x) => x.key === providerKey);
  if (!p) return null;
  const items = model.sharing.map((x, i) => ({ key: `case-${i}`, group: 'case', topic: x.topic, label: x.label, text: x.text, decision: x.decision, reason: x.reason, chips: x.chips, by: 'ai' }));

  // The provider's own slice of the file. These are built from their own row, so no other provider's data can leak in.
  const own = (key, topic, label, text, reason, chips = []) => items.push({ key, group: 'own', topic, label, text, decision: 'share', reason, chips, by: 'rule' });
  if (p.billed != null) own('own-bills', 'bills', 'Your bills on file', `We hold charges from your office of ${usd(p.billed)}${p.billed_through ? `, for services through ${shortDate(p.billed_through, 'always')}` : ''}.`, 'Their own bill. It tells them what the firm has and has not received.', p.bill_chips);
  const through = p.records_through ? ` up to ${shortDate(p.records_through, 'always')}` : '';
  const records = {
    received: 'We hold your records and nothing further is needed right now.',
    partial: `We hold your records${through}. An update is outstanding.`,
    requested: `We have asked your office for updated records${through ? `. What we hold runs${through}` : ''}.`,
    overdue: `We are still waiting on records we asked your office for${through ? `. What we hold runs${through}` : ''}.`,
  }[p.records_status];
  if (records) own('own-records', 'records', 'Your records on file', records, 'Their own records. Providers say they only ever see what they sent.', p.chips);
  if (p.needs_from_them) own('own-needs', 'needs', 'What we need from your office', p.needs_from_them, 'A clear request gets records in faster than another email.', p.chips);
  const attendance = { treating: 'Our file shows your patient is still in treatment with your office.', procedure_pending: 'Our file shows a recommended procedure with your office that has not yet been scheduled.', finished: 'Our file shows treatment with your office is complete.' }[p.treatment_status];
  if (attendance) own('own-attendance', 'attendance', 'Your patient', `${attendance}${p.records_through ? ` The last visit in the records we hold is ${shortDate(p.records_through, 'always')}.` : ''}`, 'Their own patient. It answers whether the patient is still showing up.', p.chips);
  return { provider: p, items };
}

export function createShare(model, providerKey, keys, { days, note } = {}) {
  const proposal = shareProposal(model, providerKey);
  if (!proposal) throw new Error('Unknown provider.');
  const chosen = proposal.items.filter((i) => keys.includes(i.key));
  if (!chosen.length) throw new Error('Choose at least one item to share.');
  const token = crypto.randomBytes(24).toString('base64url');
  const created = now();
  const life = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(Number(days), 90) : config.share.linkDays;
  const expires = new Date(Date.now() + life * 86_400_000).toISOString();
  const snapshot = {
    provider: proposal.provider.name,
    patient: model.client?.name || null,
    firm_user: model.firmUser || null,
    items: chosen.map(({ group, topic, label, text }) => ({ group, topic, label, text })),
    withheld: proposal.items.length - chosen.length,
    note: String(note || '').trim().slice(0, 600) || null,
  };
  const r = run(
    'INSERT INTO shares (matter_id, token_hash, token_hint, provider_key, provider_name, snapshot, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
    model.matterId, sha(token), token.slice(-4), providerKey, proposal.provider.name, JSON.stringify(snapshot), created, expires,
  );
  return { id: Number(r.lastInsertRowid), token, path: `/p/${token}`, expires_at: expires };
}

export const revokeShare = (id) => run('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id).changes > 0;

export function listShares(matterId) {
  return all('SELECT * FROM shares WHERE matter_id = ? ORDER BY id DESC', matterId).map((s) => {
    const opens = all('SELECT opened_at, agent FROM share_opens WHERE share_id = ? ORDER BY id DESC', s.id);
    return { id: s.id, provider_key: s.provider_key, provider_name: s.provider_name, created_at: s.created_at, expires_at: s.expires_at, revoked_at: s.revoked_at, hint: s.token_hint, snapshot: parseJson(s.snapshot, {}), opens, state: s.revoked_at ? 'revoked' : s.expires_at < now() ? 'expired' : 'live' };
  });
}

/** Look a link up by its token. Logs the open. Returns { state, share }. */
export function openShare(token, agent) {
  const s = get('SELECT * FROM shares WHERE token_hash = ?', sha(String(token || '')));
  if (!s) return { state: 'missing' };
  if (s.revoked_at) return { state: 'revoked' };
  if (s.expires_at < now()) return { state: 'expired' };
  run('INSERT INTO share_opens (share_id, opened_at, agent) VALUES (?,?,?)', s.id, now(), String(agent || '').slice(0, 200));
  return { state: 'live', share: { ...s, snapshot: parseJson(s.snapshot, {}) } };
}
