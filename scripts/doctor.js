// npm run doctor
// Checks each thing the app depends on and says plainly what is wrong.
// Read-only: it only ever sends GET requests to Clio and one tiny message to the AI.
import { config, aiConfigured } from '../src/config.js';
import * as clio from '../src/clio.js';
import { resolveMatterId } from '../src/pull.js';

const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);
const bad = (label, detail = '') => console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);

console.log(`\nCaseBrief doctor\n`);
ok('Node', process.versions.node);

console.log(`\nClio (${config.clio.baseUrl})`);
if (!clio.clioConfigured()) {
  bad('No access token', 'Set CLIO_ACCESS_TOKEN in .env, or set CLIO_CLIENT_ID and CLIO_CLIENT_SECRET and open /clio/login.');
} else {
  try {
    const me = await clio.whoAmI();
    ok('Token accepted', me?.name ? `signed in as ${me.name}` : '');
    const matterId = await resolveMatterId();
    const matter = await clio.getMatter(matterId);
    ok('Matter found', `${matter.display_number || ''} ${matter.description || ''} (id ${matter.id})`);
    ok('Custom fields', String((matter.custom_field_values || []).length));
    const checks = [
      ['Related contacts', () => clio.listRelatedContacts(matterId)],
      ['Notes', () => clio.listNotes(matterId)],
      ['Communications', () => clio.listCommunications(matterId)],
      ['Tasks', () => clio.listTasks(matterId)],
      ['Calendar entries', () => clio.listCalendarEntries(matterId)],
      ['Case expenses', () => clio.listActivities(matterId)],
      ['Documents', () => clio.listDocuments(matterId)],
    ];
    let firstDoc = null;
    for (const [label, fn] of checks) {
      try {
        const rows = await fn();
        ok(label, String(rows.length));
        if (label === 'Documents') firstDoc = rows[0];
      } catch (err) {
        bad(label, err.message);
      }
    }
    if (firstDoc) {
      try {
        const { bytes } = await clio.downloadDocument(firstDoc.id);
        ok('Document download', `${firstDoc.name} (${bytes.length.toLocaleString()} bytes)`);
      } catch (err) {
        bad('Document download', err.message);
      }
    }
    for (const note of clio.takeFieldNotes()) console.log(`  note  ${note}`);
  } catch (err) {
    bad('Clio', err.message);
  }
}

console.log(`\nAI (${config.ai.baseUrl})`);
if (!aiConfigured()) {
  bad('No API key', 'Set ANTHROPIC_API_KEY in .env. Without it the app still shows what Clio returns, but nothing is digested.');
} else {
  for (const model of new Set([config.ai.extractModel, config.ai.synthModel])) {
    try {
      const res = await fetch(`${config.ai.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the word ok.' }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) ok(model, 'responds');
      else bad(model, `${res.status} ${body?.error?.message || ''}`);
    } catch (err) {
      bad(model, err.message);
    }
  }
}
console.log('');
