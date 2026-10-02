import { esc, ago } from './ui.js';
import { daysBetween, today } from '../util.js';

/** The page shell for the firm's side of the app. */
export function page({ title, active, body, model = null, status = null }) {
  const opened = model?.changes?.previous;
  const openedText = opened ? `You last opened this ${ago(daysBetween(opened.slice(0, 10), today()))}` : model ? 'First time opening this brief' : '';
  const tab = (href, label, key) => `<a href="${href}" class="tab${active === key ? ' is-active' : ''}">${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · CaseBrief</title>
<link rel="stylesheet" href="/public/app.css">
</head>
<body data-running="${status?.running ? '1' : '0'}" data-view="${model ? active : 'setup'}" data-brief="${model?.hasAi ? '1' : '0'}">
<header class="top">
  <div class="top-in">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>CaseBrief</a>
    <nav class="tabs" aria-label="Views">
      ${tab('/', 'Attorney brief', 'brief')}
      ${tab('/share', 'Share review', 'share')}
      ${tab('/share/preview', 'Provider view', 'provider')}
    </nav>
    <div class="top-right">
      <span class="muted small">${esc(openedText)}</span>
      <button type="button" class="btn" id="sync">Sync from Clio</button>
    </div>
  </div>
  <div class="progress" id="progress" hidden><div class="progress-bar"><span id="progress-fill"></span></div><span id="progress-text" class="small"></span></div>
</header>
<main class="wrap">
${body}
</main>
<aside class="drawer" id="drawer" hidden aria-label="Source">
  <div class="drawer-head"><div><span class="chip chip-static" id="drawer-label"></span><h2 id="drawer-title"></h2><p class="muted small" id="drawer-sub"></p></div><button type="button" class="icon-btn" id="drawer-close" aria-label="Close">×</button></div>
  <div class="drawer-body" id="drawer-body"></div>
</aside>
<div class="scrim" id="scrim" hidden></div>
<script src="/public/app.js" defer></script>
</body>
</html>`;
}
