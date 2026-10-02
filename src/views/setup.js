import { esc } from './ui.js';
import { page } from './layout.js';

/** Shown until a matter has been pulled. Says exactly what is missing. */
export function setupPage({ clio, oauth, ai, status, baseUrl }) {
  const step = (done, title, text) => `<li class="setup-step ${done ? 'is-done' : ''}"><span class="setup-mark">${done ? '✓' : ''}</span><div><strong>${title}</strong><p class="muted">${text}</p></div></li>`;
  const body = `<section class="card setup">
    <h1>Connect a matter</h1>
    <p class="muted">CaseBrief reads one matter from Clio Manage, read-only, and digests it once. Three things are needed.</p>
    <ol class="setup-steps">
      ${step(clio, 'Clio access', clio ? `Connected to ${esc(baseUrl)}.` : oauth ? 'A Clio developer app is configured. <a class="link" href="/clio/login">Connect Clio</a> to authorise it.' : 'Put an access token in <code>CLIO_ACCESS_TOKEN</code> in <code>.env</code>, or set <code>CLIO_CLIENT_ID</code> and <code>CLIO_CLIENT_SECRET</code> and restart to use the Connect button.')}
      ${step(ai, 'AI key', ai ? 'An API key is set.' : 'Put a key in <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> in <code>.env</code> and restart. Without it the page still shows what Clio returns, undigested.')}
      ${step(false, 'First sync', clio ? 'Press the button. The first sync reads every note, email and document once. Later syncs only read what changed.' : 'Available once Clio is connected.')}
    </ol>
    <button type="button" class="btn btn-primary" id="sync-first"${clio ? '' : ' disabled'}>Pull the matter from Clio</button>
    ${status?.error ? `<div class="banner banner-bad">${esc(status.error)}</div>` : ''}
    <p class="muted small">Stuck? Run <code>npm run doctor</code> in a terminal. It checks every Clio request and the AI key and says what is wrong.</p>
  </section>`;
  return page({ title: 'Set up', active: 'brief', body, status });
}
