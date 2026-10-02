// Share review (the firm's side) and the provider page (the provider's side).
import { esc, date, chips, pill, plural, cap } from './ui.js';
import { page } from './layout.js';

const TOPIC = { status: 'Status', stage: 'Stage', coverage: 'Coverage', coverage_limit: 'Policy limit', payment: 'Payment', timeline: 'Next steps', treatment: 'Treatment', value: 'Case value', liability: 'Liability', negotiation: 'Negotiation', strategy: 'Strategy', bills: 'Bills', records: 'Records', needs: 'Request', attendance: 'Patient', other: 'Other' };

/** The card a provider sees. Used for the live link and for the firm's preview, so the two can never drift apart. */
export function providerCard(snapshot, { created, expires, preview = false } = {}) {
  const group = (name) => (snapshot.items || []).filter((i) => i.group === name);
  const block = (title, items) =>
    items.length ? `<section class="pv-block"><h2>${title}</h2>${items.map((i) => `<div class="pv-item"><span class="pv-label">${esc(i.label)}</span><p>${esc(i.text)}</p></div>`).join('')}</section>` : '';
  return `<div class="pv-card">
    <p class="eyebrow">Case update for ${esc(snapshot.provider || 'your office')}</p>
    <h1>${esc(snapshot.patient || 'Your patient')}</h1>
    <p class="muted">${preview ? 'Preview. ' : ''}Shared by ${esc(snapshot.firm_user || 'the law firm')}${created ? ` on ${date(created, 'always')}` : ''}. This page shows only what the firm approved for your office.</p>
    ${block('The case', group('case'))}
    ${block('Your office', group('own'))}
    ${snapshot.note ? `<section class="pv-block"><h2>Note from the firm</h2><p>${esc(snapshot.note)}</p></section>` : ''}
    <p class="muted small pv-foot">${expires ? `This link stops working on ${date(expires, 'always')}. ` : ''}It contains patient information. Please do not forward it. To send records or ask a question, reply to the firm directly.</p>
  </div>`;
}

export function providerPage({ state, share }) {
  const shell = (inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Case update</title><link rel="stylesheet" href="/public/app.css"></head><body class="pv"><header class="pv-top"><span class="brand"><span class="brand-mark" aria-hidden="true"></span>CaseBrief</span><span class="muted small">Secure update from the law firm</span></header><main class="pv-wrap">${inner}</main></body></html>`;
  if (state !== 'live') {
    const why = { expired: 'This link has expired.', revoked: 'The law firm has withdrawn this link.', missing: 'This link is not valid.' }[state] || 'This link is not valid.';
    return shell(`<div class="pv-card"><h1>${why}</h1><p class="muted">Ask the firm for a new link if you still need the update.</p></div>`);
  }
  return shell(providerCard(share.snapshot, { created: share.created_at, expires: share.expires_at }));
}

export function sharePage(m, { proposal, shares, status, mode = 'review' }) {
  if (!m.providers.length) {
    return page({ title: 'Share review', active: mode === 'preview' ? 'provider' : 'share', model: m, status, body: '<div class="card"><h2>No providers yet</h2><p class="muted">Sync from Clio first. Providers come from the matter\'s related contacts.</p></div>' });
  }
  const p = proposal.provider;
  const list = m.providers
    .map((x) => {
      const live = shares.filter((s) => s.provider_key === x.key && s.state === 'live');
      const opens = live.reduce((a, s) => a + s.opens.length, 0);
      const state = live.length ? (opens ? `Opened ${opens}×` : 'Sent, not opened') : 'Not shared';
      return `<a class="plist${x.key === p.key ? ' is-active' : ''}" href="/share${mode === 'preview' ? '/preview' : ''}?provider=${encodeURIComponent(x.key)}"><strong>${esc(x.name)}</strong><span class="muted small">${esc(x.role || '')}</span><span class="small ${live.length ? (opens ? 'good-text' : 'warn-text') : 'muted'}">${state}</span></a>`;
    })
    .join('');

  const item = (i) => `<label class="item">
      <input type="checkbox" class="share-toggle" value="${esc(i.key)}" data-group="${i.group}" data-label="${esc(i.label)}" data-text="${esc(i.text)}"${i.decision === 'share' ? ' checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
      <span class="item-body">
        <span class="item-top"><strong>${esc(i.label)}</strong><span class="tag">${esc(TOPIC[i.topic] || cap(i.topic))}</span>${pill(i.decision === 'share' ? 'Proposed: share' : 'Proposed: withhold', i.decision === 'share' ? 'good' : 'bad')}</span>
        <span class="item-text">${esc(i.text)}</span>
        <span class="muted small">${i.by === 'ai' ? 'Why' : 'Rule'}: ${esc(i.reason || '')} ${chips(i.chips)}</span>
      </span>
    </label>`;
  const caseItems = proposal.items.filter((i) => i.group === 'case');
  const ownItems = proposal.items.filter((i) => i.group === 'own');
  const mine = shares.filter((s) => s.provider_key === p.key);
  // A link is a frozen snapshot. If the brief has been rewritten since, say so, so the attorney can re-share.
  const current = new Set(proposal.items.map((i) => `${i.label}|${i.text}`));
  const drift = (s) => (s.snapshot.items || []).filter((i) => !current.has(`${i.label}|${i.text}`)).length;
  const history = mine.length
    ? `<h3>Links sent to this provider</h3><div class="links">${mine
        .map((s) => `<div class="linkrow"><div><strong>Link ending …${esc(s.hint || '')}</strong> ${pill(cap(s.state), s.state === 'live' ? 'good' : 'neutral')}<div class="muted small">${plural(s.snapshot.items?.length || 0, 'item')} shared ${date(s.created_at, 'always')} · expires ${date(s.expires_at, 'always')}</div><div class="small ${s.opens.length ? 'good-text' : 'warn-text'}">${s.opens.length ? `Opened ${s.opens.length}×, last <time class="localtime" datetime="${esc(s.opens[0].opened_at)}">${esc(s.opens[0].opened_at)}</time>` : 'Not opened yet'}</div>${s.state === 'live' && drift(s) ? `<div class="small warn-text">The file has moved since this was shared: ${plural(drift(s), 'item')} would read differently now. Create a new link to send the current version.</div>` : ''}</div>${s.state === 'live' ? `<button type="button" class="btn btn-quiet revoke" data-id="${s.id}">Revoke</button>` : ''}</div>`)
        .join('')}</div>`
    : '';

  const body = `<div class="section-head"><h2>${mode === 'preview' ? 'Provider view' : 'Share review'}</h2><span class="muted small">A provider sees only what you approve here. They get no access to the file.</span></div>
  ${m.hasAi ? '' : '<div class="banner banner-warn">The case has not been digested yet, so there are no proposals about the case. Sync first.</div>'}
  <div class="share">
    <aside class="card plist-card"><h3>Providers</h3>${list}</aside>
    <section class="card composer" data-provider="${esc(p.key)}">
      <h2>${esc(p.name)}</h2>
      <p class="muted">${esc(p.role || '')}. Each item comes with a proposed decision and the reason for it. Flip anything, then create the link.</p>
      <h3>About the case</h3>
      ${caseItems.map(item).join('') || '<p class="muted small">Nothing proposed yet.</p>'}
      <h3>Their own bills and records</h3>
      ${ownItems.map(item).join('') || '<p class="muted small">Nothing on file for this provider yet.</p>'}
      <h3>Add a note</h3>
      <textarea id="share-note" class="input" rows="2" maxlength="600" placeholder="Optional. For example: please send the updated ledger by Friday."></textarea>
      <div class="composer-foot">
        <label class="small muted">Link expires in <select id="share-days" class="select"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></label>
        <button type="button" class="btn btn-primary" id="share-create">Create the provider link</button>
      </div>
      <div id="share-result" class="result" hidden></div>
      ${history}
    </section>
    <section class="preview"><p class="eyebrow">What ${esc(p.name)} will see</p><div id="preview" data-provider="${esc(p.name)}" data-patient="${esc(m.client?.name || '')}" data-firm="${esc(m.firmUser || '')}"></div></section>
  </div>`;
  return page({ title: mode === 'preview' ? 'Provider view' : 'Share review', active: mode === 'preview' ? 'provider' : 'share', body, model: m, status });
}
