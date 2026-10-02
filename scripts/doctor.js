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

console.log(`\nAI (${config.ai.provider}, ${config.ai.baseUrl})`);
if (!aiConfigured()) {
  bad('No API key', 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env. Without it the app still shows what Clio returns, but nothing is digested.');
} else {
  // Three tiny requests, one for each shape the digest relies on. They cost a fraction of a cent.
  const { callTool } = await import('../src/llm.js');
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const tool = (name) => ({ name, description: 'Report one word.', input_schema: { type: 'object', properties: { word: { type: ['string', 'null'] } }, required: ['word'] } });
  const pdf = await PDFDocument.create();
  pdf.addPage([320, 120]).drawText('Doctor test page', { x: 20, y: 70, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const page = Buffer.from(await pdf.save()).toString('base64');
  const checks = [
    [`${config.ai.extractModel} answers through a tool`, () => callTool({ step: 'doctor', model: config.ai.extractModel, system: 'You are a connection test.', content: 'Call the tool with word set to "ok".', tool: tool('report'), maxTokens: 100 })],
    [`${config.ai.extractModel} reads a PDF page`, () => callTool({ step: 'doctor', model: config.ai.extractModel, system: 'You are a connection test.', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: page } }, { type: 'text', text: 'Call the tool with word set to the first word printed on the page.' }], tool: tool('report'), maxTokens: 100 })],
    [`${config.ai.synthModel} answers with a cached prompt and several tools`, () => callTool({ step: 'doctor', model: config.ai.synthModel, system: [{ type: 'text', text: 'You are a connection test.' }, { type: 'text', text: 'Case material would go here.', cache_control: { type: 'ephemeral' } }], content: 'Call the tool with word set to "ok".', tool: tool('report'), tools: [tool('report'), tool('other')], maxTokens: 100 })],
  ];
  for (const [label, fn] of checks) {
    try {
      const out = await fn();
      ok(label, out?.word ? `said "${out.word}"` : '');
    } catch (err) {
      bad(label, err.message);
    }
  }
}
console.log('');
