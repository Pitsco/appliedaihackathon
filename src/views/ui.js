// Small HTML helpers shared by the pages. Everything that reaches the browser goes through esc().
import { shortDate } from '../brief.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const usd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`);

export function usdShort(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 2)}M`;
  if (Math.abs(v) >= 10_000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`;
  return usd(v);
}

export const date = (iso, year = 'auto') => esc(shortDate(iso, year));

export const ago = (days) => (days == null ? '' : days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 0 ? `in ${-days} days` : `${days} days ago`);
export const until = (days) => (days == null ? '' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : days < 0 ? `${-days} days ago` : `in ${days} days`);

export const chip = (c) =>
  `<button type="button" class="chip" data-source="${c.source}"${c.fact ? ` data-fact="${c.fact}"` : ''}${c.page ? ` data-page="${c.page}"` : ''} title="Open the source">${esc(c.label)}</button>`;

export const chips = (list) => (list?.length ? `<span class="chips">${list.map(chip).join('')}</span>` : '');

export const listChip = (ids, label) => (ids?.length ? `<button type="button" class="chip" data-facts="${ids.join(',')}" title="Open the entries behind this number">${esc(label)}</button>` : '');

export const pill = (text, tone = 'neutral') => `<span class="pill pill-${tone}">${esc(text)}</span>`;

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
export const cap = sentence;

// Front view of a body. Anatomical left is the viewer's right.
const REGION_XY = {
  head: [60, 20], neck: [60, 44], chest: [60, 72], upper_back: [60, 62], abdomen: [60, 98], lower_back: [60, 110],
  left_shoulder: [84, 58], right_shoulder: [36, 58], left_arm: [93, 96], right_arm: [27, 96], left_hand: [99, 134], right_hand: [21, 134],
  left_hip: [72, 126], right_hip: [48, 126], left_knee: [72, 176], right_knee: [48, 176], left_leg: [72, 200], right_leg: [48, 200],
  left_ankle: [72, 224], right_ankle: [48, 224], whole_body: [60, 90], other: [60, 90],
};

export function bodyDiagram(injuries) {
  const dots = injuries
    .map((inj, i) => {
      const [x, y] = REGION_XY[inj.region] || REGION_XY.other;
      const r = inj.severity === 'major' ? 8 : inj.severity === 'moderate' ? 6.5 : 5.5;
      return `<g class="dot dot-${esc(inj.severity)}"><circle cx="${x}" cy="${y}" r="${r}"/><text x="${x}" y="${y + 3}" text-anchor="middle">${i + 1}</text></g>`;
    })
    .join('');
  return `<svg class="body" viewBox="0 0 120 240" role="img" aria-label="Body outline with the injured areas marked">
    <g class="body-shape">
      <circle cx="60" cy="20" r="14"/>
      <rect x="54" y="33" width="12" height="12" rx="4"/>
      <path d="M36 48 Q60 40 84 48 L88 60 L82 122 Q60 130 38 122 L32 60 Z"/>
      <path d="M33 54 Q22 60 22 78 L18 132 Q21 138 26 134 L33 86 Z"/>
      <path d="M87 54 Q98 60 98 78 L102 132 Q99 138 94 134 L87 86 Z"/>
      <path d="M40 124 L57 127 L55 228 Q49 234 43 228 Z"/>
      <path d="M80 124 L63 127 L65 228 Q71 234 77 228 Z"/>
    </g>
    ${dots}
  </svg>`;
}

export const KIND_LABEL = { note: 'Note', communication: 'Email or call', document: 'Document', task: 'Task', calendar: 'Calendar', activity: 'Expense' };
