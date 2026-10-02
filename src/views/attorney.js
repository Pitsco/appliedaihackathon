// The attorney brief. Order follows what the lawyers we interviewed look at first:
// the filing deadline, then fault / damages / coverage, then money, then what to do.
import { esc, usd, usdShort, date, ago, until, chip, chips, listChip, pill, plural, cap, bodyDiagram, KIND_LABEL } from './ui.js';
import { page } from './layout.js';
import { daysBetween } from '../util.js';

const TONE = {
  fault: { clear: ['Clear', 'good'], contested: ['Contested', 'warn'], weak: ['Weak', 'bad'], unknown: ['Not established', 'neutral'] },
  damages: { strong: ['Strong', 'good'], documented: ['Documented', 'good'], developing: ['Developing', 'warn'], thin: ['Thin', 'bad'], unknown: ['Not established', 'neutral'] },
  coverage: { confirmed: ['Confirmed', 'good'], disputed: ['File disagrees', 'warn'], unconfirmed: ['Unconfirmed', 'warn'], none: ['None found', 'bad'], unknown: ['Not established', 'neutral'] },
  treatment: { treating: ['Treating', 'accent'], procedure_pending: ['Procedure pending', 'warn'], finished: ['Finished', 'neutral'], not_started: ['Not started', 'neutral'], unknown: ['Unknown', 'neutral'] },
  records: { received: ['Received', 'good'], partial: ['Update outstanding', 'warn'], requested: ['Requested', 'warn'], overdue: ['Overdue', 'bad'], none: ['None', 'neutral'], unknown: ['Unknown', 'neutral'] },
  severity: { high: 'bad', medium: 'warn', low: 'neutral' },
};
const tone = (group, key) => TONE[group][key] || TONE[group].unknown;

function deadlineBox(d, next) {
  let t = 'neutral';
  let big = 'Not in the file';
  let label = 'Deadline to file';
  let sub = '';
  if (d) {
    label = d.headline || label;
    if (d.state === 'suit_filed') {
      t = 'good';
      big = d.date ? date(d.date, 'always') : 'Filed';
      sub = 'Filing deadline met';
    } else if (d.state === 'expired') {
      t = 'bad';
      big = d.date ? date(d.date, 'always') : 'Expired';
      sub = 'The file says this has passed';
    } else if (d.date && d.daysLeft != null) {
      t = d.daysLeft <= 90 ? 'bad' : d.daysLeft <= 365 ? 'warn' : 'good';
      big = d.daysLeft < 0 ? `${-d.daysLeft} days past` : d.daysLeft < 90 ? `${d.daysLeft} days left` : `${Math.round(d.daysLeft / 30.44)} months left`;
      sub = `File by ${date(d.date, 'always')}`;
    } else {
      t = 'warn';
      big = 'Not in the file';
      sub = 'No deadline is recorded. Confirm it.';
    }
  }
  return `<div class="stat stat-${t}" title="${esc(d?.detail || '')}">
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-big">${big}</span>
    <span class="stat-sub">${esc(sub)} ${chips(d?.chips)}</span>
    ${next ? `<span class="stat-sub">Next: ${date(next.date)} · ${esc(next.label || '')}</span>` : ''}
  </div>`;
}

function header(m) {
  const photo = m.client?.photo;
  const initials = (m.client?.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  // With a face box from the digest the photo is cropped to the face. Before that, show the ID as it is.
  const avatar = photo
    ? `<button type="button" class="avatar ${photo.crop ? 'avatar-photo' : 'avatar-card'}" data-source="${photo.source}" title="Open the photo ID" style="background-image:url('${photo.url}');${photo.crop ? `background-size:${photo.crop.size};background-position:${photo.crop.position}` : ''}"></button>`
    : `<div class="avatar">${esc(initials)}</div>`;
  const facts = [m.caseType && cap(m.caseType), m.incident?.location, m.incident?.date && `Date of loss ${date(m.incident.date, 'always')}`, m.caseAgeMonths != null && `Case age ${m.caseAgeMonths} months`].filter(Boolean);
  const lc = m.lastContact.spoken || m.lastContact.any;
  const lcTone = !lc ? 'neutral' : lc.days > 30 ? 'bad' : lc.days > 14 ? 'warn' : 'neutral';
  const od = m.attention.overdue.length;
  const track = m.stageTrack.length
    ? `<ol class="track">${m.stageTrack.map((s) => `<li class="track-${s.state}"><span class="track-bar"></span><span class="track-label">${esc(s.label)}${s.state === 'current' ? ' · now' : ''}</span></li>`).join('')}</ol>`
    : '';
  return `<section class="card head">
    <div class="head-row">
      <div class="head-who">
        ${avatar}
        <div>
          <h1>${esc(m.client?.name || m.matter.description || 'Matter')}</h1>
          <p class="muted">${facts.map((f) => (typeof f === 'string' ? esc(f) : f)).join(' · ')} ${chips(m.incident?.chips)}</p>
          <p class="muted small">Clio matter ${esc(m.matter.number || m.matterId)}${m.matter.status ? ` · ${esc(m.matter.status)}` : ''}${m.incident?.summary ? ` · ${esc(m.incident.summary)}` : ''}</p>
        </div>
      </div>
      <div class="head-stats">
        ${deadlineBox(m.deadline, m.nextDate)}
        <div class="stat stat-${lcTone}">
          <span class="stat-label">Last client contact</span>
          <span class="stat-big">${lc ? esc(cap(ago(lc.days))) : 'None logged'}</span>
          <span class="stat-sub">${lc ? `${esc(lc.how)} ${chip(lc.chip)}` : ''}</span>
          ${m.lastContact.spoken && m.lastContact.any && m.lastContact.any.date > m.lastContact.spoken.date ? `<span class="stat-sub">Last email ${date(m.lastContact.any.date)}</span>` : ''}
        </div>
        <a class="stat stat-${od ? 'bad' : 'good'} stat-link" href="#attention">
          <span class="stat-label">Overdue</span>
          <span class="stat-big">${od}</span>
          <span class="stat-sub">${od ? `oldest ${m.attention.overdue[0].days} days late` : 'nothing late'}</span>
        </a>
      </div>
    </div>
    ${track}
    ${m.status ? `<p class="status"><strong>${esc(m.status.line)}</strong> <span class="muted">${esc(m.status.detail || '')}</span> ${chips(m.status.chips)}</p>` : ''}
  </section>`;
}

function testRow(m) {
  if (!m.test) return '';
  const { fault, coverage, damages } = m.test;
  const clear = [fault.status === 'clear', ['strong', 'documented'].includes(damages.status), coverage.status === 'confirmed'].filter(Boolean).length;
  const card = (label, hint, block, group, extra = '') => {
    const [text, t] = tone(group, block.status);
    return `<article class="card test">
      <div class="test-top"><span class="eyebrow">${label} <span class="muted">· ${hint}</span></span>${pill(text, t)}</div>
      <h3>${esc(block.headline || '')}</h3>
      ${extra}
      <p class="muted">${esc(block.plain || '')}</p>
      ${chips(block.chips)}
    </article>`;
  };
  const injury = (i) => `<li><div><strong>${esc(i.name)}</strong> ${i.status ? `<span class="tag">${esc(i.status)}</span>` : ''} ${chips(i.chips)}</div><p class="muted small">${esc(i.plain || '')}</p></li>`;
  const first = m.injuries.slice(0, 3);
  const rest = m.injuries.slice(3);
  const injuries = m.injuries.length
    ? `<div class="injuries">${bodyDiagram(m.injuries)}<div><ol class="injury-list">${first.map(injury).join('')}</ol>${rest.length ? `<details class="more"><summary>${plural(rest.length, 'more injury', 'more injuries')}: ${rest.map((i) => esc(i.name)).join(', ')}</summary><ol class="injury-list" start="${first.length + 1}">${rest.map(injury).join('')}</ol></details>` : ''}</div></div>`
    : '';
  return `<div class="section-head"><h2>Does the case hold up?</h2><span class="muted small">${clear} of 3 checks clear · someone at fault, real injuries, money to recover</span></div>
  <section class="grid test-grid">
    ${card('Fault', 'who caused it', fault, 'fault')}
    ${card('Damages', 'the injuries', damages, 'damages', injuries)}
    ${card('Coverage', 'who pays', coverage, 'coverage')}
  </section>`;
}

function moneyRow(m) {
  const $ = m.money;
  const tiles = [];
  if ($.value) {
    const big = $.value.amount != null ? usdShort($.value.amount) : $.value.low != null && $.value.high != null ? `${usdShort($.value.low)}–${usdShort($.value.high)}` : 'Not valued';
    tiles.push(`<div class="tile"><span class="eyebrow">Case value</span><span class="tile-big">${big}</span><span class="muted small">${esc($.value.basis || '')}</span>${chips($.value.chips)}</div>`);
  }
  if ($.cap != null) tiles.push(`<div class="tile"><span class="eyebrow">Recovery cap</span><span class="tile-big">${usdShort($.cap)}</span><span class="muted small">${$.ceiling != null ? `${usd($.ceiling)} left after ${$.liensTotal ? 'the lien' : 'liens'} and firm costs, before fees` : 'Per-person limit'}</span>${chips(m.test?.coverage.chips?.slice(0, 1))}</div>`);
  tiles.push(`<div class="tile"><span class="eyebrow">Medical bills to date</span><span class="tile-big">${usdShort($.bills.total)}</span><span class="muted small">${$.bills.from === 'clio' ? `${plural($.bills.count, 'expense entry', 'expense entries')} in Clio, ${plural($.bills.providers, 'provider')}` : $.bills.total ? 'From the bills in the file' : 'No bills found yet'}${$.bills.note ? ` · ${esc($.bills.note)}` : ''}</span><span class="chips">${listChip($.bills.facts, plural($.bills.count, 'ENTRY', 'ENTRIES'))}${($.bills.chips || []).map(chip).join('')}</span></div>`);
  tiles.push(`<div class="tile"><span class="eyebrow">Firm has spent</span><span class="tile-big">${usdShort($.firm.total)}</span><span class="muted small">${$.firm.count ? 'Costs the firm paid, from Clio expense entries' : 'No firm costs found yet'}</span>${listChip($.firm.facts, plural($.firm.count, 'EXPENSE'))}</div>`);
  if ($.liens.length) tiles.push(`<div class="tile"><span class="eyebrow">Liens</span><span class="tile-big">${usdShort($.liensTotal)}</span><span class="muted small">${$.liens.map((l) => esc(l.holder)).join(', ')}${$.liens[0].note ? ` · ${esc($.liens[0].note)}` : ''}</span>${chips($.liens.flatMap((l) => l.chips).slice(0, 2))}</div>`);
  if ($.wage) tiles.push(`<div class="tile"><span class="eyebrow">Wage loss claimed</span><span class="tile-big">${usdShort($.wage.amount)}</span><span class="muted small">${esc($.wage.basis || '')}</span>${chips($.wage.chips)}</div>`);
  return `<section class="tiles">${tiles.join('')}</section>`;
}

function attention(m) {
  const a = m.attention;
  const soon = a.upcoming.slice(0, 4);
  const waiting = (w) => `<div class="row row-quiet"><strong>${esc(w.what)}</strong><span class="small muted">${esc(w.who || '')}${w.since ? ` · since ${date(w.since)} (${w.days} days)` : ''}${w.attempts ? ` · asked ${w.attempts} times` : ''}</span>${chips(w.chips)}</div>`;
  return `<article class="card" id="attention">
    <h2>Needs attention</h2>
    <h4 class="group group-bad">Overdue · ${a.overdue.length}</h4>
    ${a.overdue.map((x) => `<button type="button" class="row row-bad" data-source="${x.chip.source}"><strong>${esc(x.title)}</strong><span class="small">Due ${date(x.date)} · ${x.days} days late${x.who ? ` · ${esc(x.who)}` : ''}</span></button>`).join('') || '<p class="muted small">Nothing is past due.</p>'}
    <h4 class="group group-warn">Coming up · ${a.upcoming.length}</h4>
    ${soon.map((x) => `<button type="button" class="row" data-source="${x.chip.source}"><strong>${esc(x.title)}</strong><span class="small muted">${x.date ? `${date(x.date)} · ${until(x.days)}` : 'No date'} · ${x.type === 'event' ? 'calendar' : 'task'}</span></button>`).join('') || '<p class="muted small">Nothing scheduled.</p>'}
    ${a.upcoming.length > soon.length ? `<details class="more"><summary>${a.upcoming.length - soon.length} more coming up</summary>${a.upcoming.slice(4).map((x) => `<button type="button" class="row" data-source="${x.chip.source}"><strong>${esc(x.title)}</strong><span class="small muted">${x.date ? `${date(x.date)} · ${until(x.days)}` : 'No date'} · ${x.type === 'event' ? 'calendar' : 'task'}</span></button>`).join('')}</details>` : ''}
    ${a.waiting.length ? `<h4 class="group group-neutral">Waiting on others · ${a.waiting.length}</h4>${a.waiting.slice(0, 3).map(waiting).join('')}${a.waiting.length > 3 ? `<details class="more"><summary>${a.waiting.length - 3} more</summary>${a.waiting.slice(3).map(waiting).join('')}</details>` : ''}` : ''}
  </article>`;
}

function changes(m) {
  const ch = m.changes;
  const shown = ch.items.slice(0, 8);
  const option = (v, label) => `<option value="${v}"${ch.choice === v ? ' selected' : ''}>${label}</option>`;
  const tag = { new: ['New', 'accent'], changed: ['Edited', 'warn'], late: ['Late', 'bad'] };
  return `<article class="card">
    <div class="card-top"><h2>${esc(ch.label)} <span class="muted">· ${plural(ch.items.length, 'change')}</span></h2>
      <select id="since" class="select" aria-label="Period">${option('last', 'Since last opened')}${option('7d', 'Last 7 days')}${option('30d', 'Last 30 days')}${option('90d', 'Last 90 days')}</select></div>
    ${ch.firstVisit ? '<p class="muted small">No earlier visit on record, so this shows the last 14 days.</p>' : ''}
    ${shown.map((x) => `<button type="button" class="change" data-source="${x.chip.source}">${pill(tag[x.tag][0], tag[x.tag][1])}<span class="change-text">${esc(x.text)}</span><span class="muted small">${date(x.date)}</span></button>`).join('') || '<p class="muted">Nothing has changed in this period.</p>'}
    ${ch.items.length > shown.length ? `<p class="muted small">and ${ch.items.length - shown.length} more, in the timeline below</p>` : ''}
  </article>`;
}

function conflicts(m) {
  if (!m.conflicts.length) return '';
  return `<section class="card">
    <div class="card-top"><h2>Where the file disagrees with itself <span class="muted">· ${m.conflicts.length}</span></h2><span class="muted small">Resolve these before the next settlement discussion or deposition</span></div>
    <div class="conflicts">${m.conflicts
      .map((x) => `<div class="conflict">${pill(cap(x.severity), TONE.severity[x.severity] || 'neutral')}<div><strong>${esc(x.title)}</strong>${x.by === 'check' ? ' <span class="tag">arithmetic check</span>' : ''}<p class="muted">${esc(x.detail)}</p>${chips(x.chips)}</div></div>`)
      .join('')}</div>
  </section>`;
}

/** Where the last-visit date comes from: the page of the record that documents it, when there is one. */
function lastVisitChip(p) {
  const v = p.documented?.visits?.find((x) => x.date === p.last_visit);
  return v ? ` <button type="button" class="chip" data-source="${v.source}" data-page="${v.page}" title="Open the record of this visit">P.${v.page}</button>` : '';
}

function providers(m) {
  if (!m.providers.length) return '';
  const order = { treating: 0, procedure_pending: 1, not_started: 2, unknown: 3, finished: 4 };
  const rows = [...m.providers].sort((a, b) => (order[a.treatment_status] ?? 9) - (order[b.treatment_status] ?? 9) || (b.billed || 0) - (a.billed || 0));
  const total = rows.reduce((a, p) => a + (p.billed || 0), 0);
  const treating = rows.filter((p) => ['treating', 'procedure_pending'].includes(p.treatment_status)).length;
  const share = (p) => {
    if (!p.share) return `<a class="link small" href="/share?provider=${encodeURIComponent(p.key)}">Share</a>`;
    if (p.share.revoked) return `<a class="link small" href="/share?provider=${encodeURIComponent(p.key)}">Revoked</a>`;
    if (p.share.expired) return `<a class="link small" href="/share?provider=${encodeURIComponent(p.key)}">Expired</a>`;
    return `<a class="link small" href="/share?provider=${encodeURIComponent(p.key)}">${p.share.opens ? `Opened ${p.share.opens}×` : 'Sent, not opened'}</a>`;
  };
  return `<section class="card">
    <div class="card-top"><h2>Treatment and bills <span class="muted">· ${treating} still treating</span></h2>
      <select id="provider-sort" class="select" aria-label="Sort providers"><option value="status">Sort: treatment status</option><option value="billed">Sort: amount billed</option><option value="visit">Sort: last visit</option><option value="records">Sort: records outstanding</option></select></div>
    <div class="table-wrap"><table class="table" id="providers">
      <thead><tr><th>Provider</th><th>Status</th><th>Last visit</th><th>Records</th><th class="num">Billed</th><th>Paid by</th><th>Shared</th></tr></thead>
      <tbody>${rows
        .map((p) => {
          const [st, stTone] = tone('treatment', p.treatment_status);
          const [rc, rcTone] = tone('records', p.records_status);
          const recOrder = { overdue: 0, requested: 1, partial: 2, unknown: 3, none: 4, received: 5 }[p.records_status] ?? 3;
          return `<tr data-status="${order[p.treatment_status] ?? 9}" data-billed="${p.billed || 0}" data-visit="${esc(p.last_visit || '')}" data-records="${recOrder}">
            <td><strong>${esc(p.name)}</strong><div class="muted small">${esc(p.role || '')} ${chips(p.chips)}</div></td>
            <td>${pill(st, stTone)}<div class="muted small">${esc(p.status_note || '')}</div>${p.big_gap ? `<div class="small warn-text" title="From the visit dates in the records on file">Gap of ${p.big_gap.days} days, ${date(p.big_gap.from, 'always')} to ${date(p.big_gap.to, 'always')}</div>` : ''}</td>
            <td>${p.last_visit ? `<span class="nowrap">${date(p.last_visit, 'always')}</span>${lastVisitChip(p)}` : '<span class="muted">—</span>'}${p.documented ? `<div class="muted small">${plural(p.documented.count, 'visit')} in the records</div>` : ''}</td>
            <td><span class="rec rec-${rcTone}">${esc(rc)}</span><div class="muted small">${esc(p.records_note || '')}</div>${p.records_stale ? `<div class="small warn-text">On file only through ${date(p.records_through, 'always')}</div>` : ''}</td>
            <td class="num"><strong>${p.billed != null ? usd(p.billed) : '—'}</strong><div class="chips">${(p.bill_chips || []).map(chip).join('')}</div></td>
            <td>${esc(p.paid_by || '—')}</td>
            <td>${share(p)}</td>
          </tr>`;
        })
        .join('')}</tbody>
      <tfoot><tr><td colspan="4"><strong>Total · ${plural(rows.length, 'provider')}</strong></td><td class="num"><strong>${usd(total)}</strong></td><td colspan="2" class="muted small">${m.money.bills.stated != null ? `File states ${usd(m.money.bills.stated)}` : ''}</td></tr></tfoot>
    </table></div>
    ${visitStrip(m)}
  </section>`;
}

/** One line per provider, one tick per visit found in the records. Gaps and undocumented stretches stand out. */
function visitStrip(m) {
  const rows = m.providers.filter((p) => p.documented?.visits?.length);
  if (!rows.length) return '';
  const start = [m.incident?.date, ...rows.map((p) => p.documented.first)].filter(Boolean).sort()[0];
  const span = Math.max(1, daysBetween(start, m.today));
  const W = 1000;
  const L = 250;
  const R = 16;
  const rowH = 24;
  const top = 24;
  const H = top + rows.length * rowH + 6;
  const x = (d) => (L + ((W - L - R) * Math.max(0, Math.min(span, daysBetween(start, d)))) / span).toFixed(1);
  const years = [];
  for (let y = Number(start.slice(0, 4)) + 1; y <= Number(m.today.slice(0, 4)); y++) years.push(y);
  const lines = rows
    .map((p, i) => {
      const y = top + i * rowH;
      const open = ['treating', 'procedure_pending'].includes(p.treatment_status);
      const gaps = p.documented.count >= 8 ? p.documented.gaps.map((g) => `<rect class="vs-gap" x="${x(g.from)}" y="${y + 3}" width="${Math.max(2, x(g.to) - x(g.from)).toFixed(1)}" height="14"><title>No visit for ${g.days} days, ${g.from} to ${g.to}</title></rect>`).join('') : '';
      const dark = open && daysBetween(p.documented.last, m.today) > 60 ? `<rect class="vs-dark" x="${x(p.documented.last)}" y="${y + 3}" width="${(x(m.today) - x(p.documented.last)).toFixed(1)}" height="14"><title>Still treating, but no records since ${p.documented.last}</title></rect>` : '';
      const ticks = p.documented.visits.map((v) => `<rect class="vs-tick" x="${x(v.date)}" y="${y + 3}" width="2" height="14" data-source="${v.source}" data-page="${v.page}"><title>${v.date}</title></rect>`).join('');
      return `<text class="vs-name" x="0" y="${y + 14}">${esc(p.name.length > 36 ? `${p.name.slice(0, 35)}…` : p.name)}</text><line class="vs-base" x1="${L}" x2="${W - R}" y1="${y + 10}" y2="${y + 10}"/>${gaps}${dark}${ticks}`;
    })
    .join('');
  return `<div class="visits">
    <div class="card-top"><h3>Visits in the records</h3><span class="muted small"><span class="key key-tick"></span>a visit <span class="key key-gap"></span>gap over 30 days <span class="key key-dark"></span>still treating, no records held</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Visits per provider over time, from the dates in the medical records">
      ${years.map((y) => `<line class="vs-year" x1="${x(`${y}-01-01`)}" x2="${x(`${y}-01-01`)}" y1="14" y2="${H}"/><text class="vs-label" x="${x(`${y}-01-01`)}" y="10" text-anchor="middle">${y}</text>`).join('')}
      <text class="vs-label" x="${L}" y="10">${m.incident?.date ? 'Date of loss' : ''}</text><text class="vs-label" x="${W - R}" y="10" text-anchor="end">Today</text>
      ${lines}
    </svg>
  </div>`;
}

function pitch(m) {
  if (!m.pitch.length && !m.money.offers.length) return '';
  return `<section class="grid two">
    <article class="card"><h2>The pitch <span class="muted">· 60 seconds</span></h2><p class="pitch">${m.pitch.map((p) => `${esc(p.text)} ${chips(p.chips)}`).join(' ')}</p></article>
    <article class="card"><h2>Demands and offers</h2>${m.money.offers.map((o) => `<div class="row row-quiet"><strong>${o.amount != null ? `${usd(o.amount)} · ` : ''}${esc(o.from || '')}</strong><span class="small muted">${o.date ? date(o.date, 'always') : ''}</span><p class="muted small">${esc(o.summary)}</p>${chips(o.chips)}</div>`).join('') || '<p class="muted">No demand or offer in the file.</p>'}</article>
  </section>`;
}

function entries(m) {
  const row = (e, i, ranked) => `<button type="button" class="entry" data-source="${e.id}" data-kind="${e.kind}">
      <span class="entry-date">${ranked ? `<span class="rank">${i + 1}</span>` : ''}${e.date ? date(e.date, 'always') : '—'}</span>
      <span class="entry-kind">${esc(e.kindLabel)}</span>
      <span class="entry-text"><strong>${esc(e.title)}</strong>${e.summary || e.why ? `<span class="muted small">${esc(ranked ? e.why || e.summary : e.summary || '')}</span>` : ''}</span>
      <span class="tag">${esc(cap(e.category || KIND_LABEL[e.kind] || ''))}</span>
    </button>`;
  const kinds = [...new Set(m.timeline.map((e) => e.kind))];
  return `<section class="card" id="entries">
    <div class="card-top"><h2>The ${m.top.length} entries that matter <span class="muted">· of ${m.timeline.length}</span></h2>
      <div class="seg" role="tablist"><button type="button" class="seg-btn is-active" data-show="top">Top ${m.top.length}</button><button type="button" class="seg-btn" data-show="all">Full timeline (${m.timeline.length})</button></div></div>
    <div id="entries-top">${m.top.map((e, i) => row(e, i, true)).join('') || '<p class="muted">Run the digest to rank the entries.</p>'}</div>
    <div id="entries-all" hidden>
      <div class="filters">${kinds.map((k) => `<label class="check"><input type="checkbox" class="kind-filter" value="${k}" checked> ${esc(KIND_LABEL[k] || k)}</label>`).join('')}</div>
      ${m.timeline.map((e, i) => row(e, i, false)).join('')}
    </div>
  </section>`;
}

function footer(m) {
  const d = m.digest;
  const n = d.counts;
  const parts = [n.note && plural(n.note, 'note'), n.communication && `${n.communication} emails and calls`, n.task && plural(n.task, 'task'), n.calendar && `${n.calendar} calendar entries`, n.activity && `${n.activity} expense entries`, n.document && plural(n.document, 'document'), n.contact && plural(n.contact, 'contact'), n.field && `${n.field} custom fields`].filter(Boolean);
  const money = (v) => (v == null ? 'price not set' : `$${Number(v).toFixed(2)}`);
  return `<section class="card foot">
    <h2>About this digest</h2>
    <p class="muted small">Read live from Clio matter ${esc(m.matter.number || m.matterId)}, read-only: ${parts.join(', ')}.${d.pagesTotal ? ` ${d.pagesRead} of ${d.pagesTotal} document pages read.` : ''}</p>
    <p class="muted small">Last sync ${d.lastPull ? `<time datetime="${esc(d.lastPull)}" class="localtime">${esc(d.lastPull)}</time>` : 'never'}${d.lastRun ? ` · that sync made ${plural(d.lastRun.calls, 'AI call')} (${money(d.lastRun.calls ? d.lastRun.usd : 0)})` : ''}. Digesting this case has cost <strong>${money(d.cost.calls ? d.cost.usd : 0)}</strong> in total, over ${plural(d.cost.calls, 'AI call')} (${Number(d.cost.input).toLocaleString('en-US')} tokens in, ${Number(d.cost.output).toLocaleString('en-US')} out). Unchanged items are never read twice.</p>
    ${d.quotes?.n ? `<p class="muted small">${d.quotes.ok} of ${d.quotes.n} AI facts carry a quote found word for word in the source${d.quotes.bad ? `; ${d.quotes.bad} could not be matched and are marked in the source panel` : ''}. Facts from bare scans cannot be checked this way.</p>` : ''}
    ${d.unread.length ? `<p class="small warn-text">${plural(d.unread.length, 'item')} could not be fully read: ${d.unread.slice(0, 6).map((u) => `${chip(u.chip)} ${esc(u.error)}`).join(' ')}</p>` : ''}
  </section>`;
}

function banners(m, status) {
  const out = [];
  if (!m.aiConfigured) out.push('<div class="banner banner-warn">No AI key is set, so nothing has been digested. Add ANTHROPIC_API_KEY to .env, restart, and sync. Everything below comes straight from Clio.</div>');
  else if (!m.hasAi) out.push('<div class="banner banner-warn">This matter has been pulled from Clio but not digested yet. Press “Sync from Clio”.</div>');
  if (m.partial) out.push('<div class="banner banner-info">First brief from notes, emails, tasks and expenses. The documents are still being read and the brief will be rewritten when they are done.</div>');
  if (status?.error && !status.running) out.push(`<div class="banner banner-bad">The last sync stopped: ${esc(status.error)}</div>`);
  for (const w of (status?.warnings || []).slice(0, 4)) out.push(`<div class="banner banner-warn">${esc(w)}</div>`);
  return out.join('');
}

export function attorneyPage(m, status) {
  const body = `${banners(m, status)}
  ${header(m)}
  ${testRow(m)}
  ${moneyRow(m)}
  <section class="grid two">${attention(m)}${changes(m)}</section>
  ${conflicts(m)}
  ${providers(m)}
  ${pitch(m)}
  ${entries(m)}
  ${footer(m)}`;
  return page({ title: m.client?.name || 'Brief', active: 'brief', body, model: m, status });
}
