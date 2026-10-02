// Browser side of the firm's pages. No framework: a source panel, a sync button, a few toggles.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const getJson = async (url, options) => {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  };
  const post = (url, data) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

  // Times are stored in UTC and shown in the reader's own time zone.
  for (const el of $$('time.localtime')) {
    const d = new Date(el.getAttribute('datetime'));
    if (!Number.isNaN(d.getTime())) el.textContent = d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // ------------------------------------------------------------------ source panel
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  const closeDrawer = () => {
    if (!drawer) return;
    drawer.hidden = true;
    scrim.hidden = true;
    $('#drawer-body').innerHTML = '';
  };
  const openDrawer = (label, title, sub, html) => {
    $('#drawer-label').textContent = label;
    $('#drawer-title').textContent = title;
    $('#drawer-sub').textContent = sub || '';
    $('#drawer-body').innerHTML = html;
    drawer.hidden = false;
    scrim.hidden = false;
    $('#drawer-body').scrollTop = 0;
    $('#drawer-body mark')?.scrollIntoView({ block: 'center' });
  };

  /** Wrap the quoted passage in <mark>, tolerating differences in whitespace and typographic quotes. */
  function highlight(text, quote) {
    if (!text) return '';
    if (!quote) return esc(text);
    const pattern = quote
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/['‘’]/g, "['‘’]")
      .replace(/["“”]/g, '["“”]')
      .replace(/\s+/g, '\\s+');
    let m = null;
    try {
      m = new RegExp(pattern, 'i').exec(text);
    } catch {
      m = null;
    }
    if (!m) return esc(text);
    return `${esc(text.slice(0, m.index))}<mark>${esc(m[0])}</mark>${esc(text.slice(m.index + m[0].length))}`;
  }

  const KIND = { note: 'Note', communication: 'Communication', document: 'Document', task: 'Task', calendar: 'Calendar entry', activity: 'Case expense', field: 'Clio custom field', contact: 'Clio contact', matter: 'Clio matter record' };

  async function showSource(id, { fact, page } = {}) {
    const q = new URLSearchParams();
    if (fact) q.set('fact', fact);
    if (page) q.set('page', page);
    let s;
    try {
      s = await getJson(`/api/source/${id}?${q}`);
    } catch (err) {
      return openDrawer('SOURCE', 'Could not open the source', '', `<p class="muted">${esc(err.message)}</p>`);
    }
    const parts = [];
    const m = s.meta || {};
    const rows = [];
    if (s.kind === 'communication') rows.push(['From', (m.from || []).map((p) => p.name).join(', ')], ['To', (m.to || []).map((p) => p.name).join(', ')], ['Type', m.type === 'phone' ? 'Phone call' : 'Email']);
    if (s.kind === 'note' && m.author) rows.push(['Author', m.author]);
    if (s.kind === 'task') rows.push(['Status', m.status], ['Due', s.dateText], ['Assigned to', m.assignee]);
    if (s.kind === 'activity') rows.push(['Amount', m.amount != null ? `$${Number(m.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''], ['Clio flag', m.non_billable ? 'Non-billable' : 'Billable to the matter']);
    if (s.kind === 'document') rows.push(['Folder', m.folder], ['Pages', s.pages ? `${s.pages}${s.pagesRead != null && s.pagesRead < s.pages ? ` (${s.pagesRead} read)` : ''}` : ''], ['File', m.filename]);
    if (s.kind === 'contact') rows.push(['Relationship', m.relationship], ['Email', m.email], ['Phone', m.phone], ['Address', m.address ? [m.address.street, m.address.city, m.address.state, m.address.zip].filter(Boolean).join(', ') : '']);
    const shown = rows.filter(([, v]) => v);
    if (shown.length) parts.push(`<dl class="meta-grid">${shown.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);

    if (s.fact) {
      const check = s.fact.origin === 'clio' ? 'Taken directly from a Clio field.' : s.fact.quote_verified === 1 ? 'Quote found word for word in the source.' : s.fact.quote_verified === 0 ? 'Quote could not be matched word for word. Read the source before relying on it.' : 'From a scanned page with no text layer. Check it against the page below.';
      parts.push(`<div class="quote"><p class="eyebrow">What the brief took from here</p><p><strong>${esc(s.fact.detail)}</strong></p>${s.fact.quote ? `<p class="muted">“${esc(s.fact.quote)}”</p>` : ''}<p class="small ${s.fact.quote_verified === 0 ? 'warn-text' : 'muted'}">${check}</p></div>`);
    } else if (s.summary) {
      parts.push(`<div class="quote"><p class="eyebrow">In one line</p><p>${esc(s.summary)}</p>${s.importance_reason ? `<p class="muted small">${esc(s.importance_reason)}</p>` : ''}</div>`);
    }
    if (s.error) parts.push(`<p class="small warn-text">${esc(s.error)}</p>`);

    const quote = s.fact?.quote || null;
    if (s.kind === 'document') {
      if (s.body) parts.push(`<div><p class="eyebrow">Text of page ${s.page}</p><div class="source-text">${highlight(s.body, quote)}</div></div>`);
      if (s.file) {
        parts.push(s.fileKind === 'image' ? `<img src="${s.file}" alt="" style="max-width:100%;border-radius:10px">` : `<div><p class="eyebrow">The document${s.page ? `, opened at page ${s.page}` : ''} · <a class="link" href="${s.file}${s.page ? `#page=${s.page}` : ''}" target="_blank" rel="noopener">open in a new tab</a></p><iframe class="pdf" title="Document" src="${s.file}#page=${s.page || 1}&view=FitH"></iframe></div>`);
      }
    } else if (s.body) {
      parts.push(`<div><p class="eyebrow">${esc(KIND[s.kind] || 'Source')} in Clio</p><div class="source-text">${highlight(s.body, quote)}</div></div>`);
    }

    if (s.facts?.length) {
      parts.push(`<div><p class="eyebrow">Everything the digest took from this ${s.kind === 'document' ? 'document' : 'entry'} · ${s.facts.length}</p><div class="facts">${s.facts
        .slice(0, 80)
        .map((f) => `<button type="button" class="fact${s.fact && f.id === s.fact.id ? ' is-active' : ''}" data-source="${s.id}" data-fact="${f.id}"${f.page ? ` data-page="${f.page}"` : ''}><span class="tag">${esc(f.type.replace(/_/g, ' '))}</span>${f.page ? ` <span class="muted small">p.${f.page}</span>` : ''} ${esc(f.detail)}</button>`)
        .join('')}</div></div>`);
    }
    openDrawer(s.label, s.title, [KIND[s.kind], s.dateText, s.clio ? `Clio id ${s.clio}` : ''].filter(Boolean).join(' · '), parts.join(''));
  }

  async function showFacts(ids, label) {
    const rows = await getJson(`/api/facts?ids=${ids}`);
    const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    openDrawer(label, 'The entries behind this number', total ? `Adds up to $${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}. Added up by the app from Clio's own amounts.` : '', `<div class="facts">${rows.map((r) => `<button type="button" class="fact" data-source="${r.source}" data-fact="${r.id}"${r.page ? ` data-page="${r.page}"` : ''}><span class="chip chip-static">${esc(r.label)}</span> ${r.amount != null ? `<strong>$${Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong> · ` : ''}${esc(r.detail)}</button>`).join('')}</div>`);
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-source], [data-facts]');
    if (!el) return;
    if (el.closest('label.item')) ev.preventDefault(); // a chip inside a toggle row must not flip the toggle
    if (el.dataset.facts) return void showFacts(el.dataset.facts, el.textContent.trim());
    showSource(el.dataset.source, { fact: el.dataset.fact, page: el.dataset.page });
  });
  $('#drawer-close')?.addEventListener('click', closeDrawer);
  scrim?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (ev) => ev.key === 'Escape' && closeDrawer());

  // ------------------------------------------------------------------ sync
  const progress = $('#progress');
  const syncBtn = $('#sync');
  let polling = false;
  async function poll(reloadWhenDone) {
    if (polling) return;
    polling = true;
    for (;;) {
      let st;
      try {
        st = await getJson('/api/status');
      } catch {
        break;
      }
      if (progress) {
        progress.hidden = !st.running;
        const share = st.total ? st.done / st.total : 0;
        const base = { pull: 0.05, read: 0.1, brief: 0.9, documents: 0.1 }[st.phase] ?? 0.02;
        $('#progress-fill').style.width = `${Math.round(Math.min(0.97, st.phase === 'brief' ? 0.92 : base + share * 0.8) * 100)}%`;
        $('#progress-text').textContent = st.total && ['read', 'documents'].includes(st.phase) ? `${st.message} · ${st.done} of ${st.total} items read` : st.message;
      }
      if (syncBtn) syncBtn.disabled = st.running;
      // Show progress as it becomes useful: the matter once it is pulled, then the first brief
      // while documents are still being read. Each of these reloads the page once per sync.
      const view = document.body.dataset.view;
      const stage = view === 'setup' && ['read', 'brief', 'documents'].includes(st.phase) ? 'pulled' : view === 'brief' && document.body.dataset.brief !== '1' && st.phase === 'documents' ? 'first-brief' : null;
      if (st.running && reloadWhenDone && stage && sessionStorage.getItem('casebrief-stage') !== `${st.startedAt}:${stage}`) {
        sessionStorage.setItem('casebrief-stage', `${st.startedAt}:${stage}`);
        location.reload();
        return;
      }
      if (!st.running) {
        if (reloadWhenDone) location.reload();
        break;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    polling = false;
  }
  const startSync = async (options) => {
    try {
      await post('/api/sync', options);
      poll(true);
    } catch (err) {
      alert(err.message);
    }
  };
  syncBtn?.addEventListener('click', (ev) => startSync({ rebuild: ev.shiftKey }));
  $('#sync-first')?.addEventListener('click', () => startSync({}));
  if (document.body.dataset.running === '1') poll(true);

  // ------------------------------------------------------------------ attorney page
  if ($('#attention')) post('/api/view').catch(() => {});

  $('#since')?.addEventListener('change', (ev) => {
    const url = new URL(location.href);
    if (ev.target.value === 'last') url.searchParams.delete('since');
    else url.searchParams.set('since', ev.target.value);
    location.href = url.toString();
  });

  $('#provider-sort')?.addEventListener('change', (ev) => {
    const body = $('#providers tbody');
    const key = ev.target.value;
    const rows = $$('tr', body);
    rows.sort((a, b) => {
      if (key === 'billed') return Number(b.dataset.billed) - Number(a.dataset.billed);
      if (key === 'visit') return String(b.dataset.visit).localeCompare(String(a.dataset.visit));
      if (key === 'records') return Number(a.dataset.records) - Number(b.dataset.records) || Number(b.dataset.billed) - Number(a.dataset.billed);
      return Number(a.dataset.status) - Number(b.dataset.status) || Number(b.dataset.billed) - Number(a.dataset.billed);
    });
    rows.forEach((r) => body.appendChild(r));
  });

  for (const btn of $$('.seg-btn')) {
    btn.addEventListener('click', () => {
      $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      $('#entries-top').hidden = btn.dataset.show !== 'top';
      $('#entries-all').hidden = btn.dataset.show !== 'all';
    });
  }
  for (const box of $$('.kind-filter')) {
    box.addEventListener('change', () => {
      const on = new Set($$('.kind-filter').filter((b) => b.checked).map((b) => b.value));
      $$('#entries-all .entry').forEach((row) => (row.hidden = !on.has(row.dataset.kind)));
    });
  }

  // ------------------------------------------------------------------ share review
  const composer = $('.composer');
  if (composer) {
    const preview = $('#preview');
    const chosen = () => $$('.share-toggle').filter((t) => t.checked);
    let timer = null;
    const render = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const items = chosen().map((t) => ({ group: t.dataset.group, label: t.dataset.label, text: t.dataset.text }));
        const res = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: preview.dataset.provider, patient: preview.dataset.patient, firm_user: preview.dataset.firm, items, note: $('#share-note').value }) });
        preview.innerHTML = await res.text();
      }, 80);
    };
    $$('.share-toggle').forEach((t) => t.addEventListener('change', render));
    $('#share-note').addEventListener('input', render);
    render();

    $('#share-create').addEventListener('click', async () => {
      const box = $('#share-result');
      try {
        const out = await post('/api/shares', { provider: composer.dataset.provider, keys: chosen().map((t) => t.value), days: Number($('#share-days').value), note: $('#share-note').value });
        box.hidden = false;
        box.innerHTML = `<strong>Link created. It is shown once, so copy it now.</strong><input type="text" readonly value="${esc(out.url)}" id="share-url"><div class="result-actions"><button type="button" class="btn" id="share-copy">Copy link</button><a class="btn" href="${esc(out.url)}" target="_blank" rel="noopener">Open as the provider</a></div><span class="muted small">Only a fingerprint of the link is stored. Every open is logged and shown on the brief.</span>`;
        $('#share-copy').addEventListener('click', async () => {
          await navigator.clipboard.writeText(out.url).catch(() => $('#share-url').select());
          $('#share-copy').textContent = 'Copied';
        });
      } catch (err) {
        box.hidden = false;
        box.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
      }
    });
    $$('.revoke').forEach((b) =>
      b.addEventListener('click', async () => {
        await post(`/api/shares/${b.dataset.id}/revoke`);
        location.reload();
      }),
    );
  }
})();
