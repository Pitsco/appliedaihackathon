// npm run sync            pull from Clio, digest what is new, rewrite the brief
// npm run sync -- --pull-only   pull from Clio without calling the AI
// npm run sync -- --rebuild     read every item again (use after changing a prompt)
// The same pipeline the "Sync from Clio" button runs, with progress in the terminal.
import { runSync, syncStatus } from '../src/pipeline.js';

const flags = new Set(process.argv.slice(2));
let last = '';
const timer = setInterval(() => {
  const s = syncStatus();
  const line = `${s.message}${s.total ? ` (${s.done}/${s.total} items)` : ''}`;
  if (line !== last) console.log(`  ${line}`);
  last = line;
}, 400);

try {
  await runSync({ rebuild: flags.has('--rebuild'), pullOnly: flags.has('--pull-only') });
  const s = syncStatus();
  const t = s.lastRun?.totals;
  console.log(`\nDone. ${s.message}.`);
  if (t) console.log(`AI calls: ${t.calls}, tokens in: ${t.input_tokens}, out: ${t.output_tokens}, cost: ${t.cost_usd == null ? 'price not set' : `$${t.cost_usd.toFixed(2)}`}`);
  for (const w of s.warnings) console.log(`Warning: ${w}`);
} catch (err) {
  console.error(`\nSync stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
