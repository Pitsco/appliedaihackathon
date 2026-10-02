# CaseBrief

A personal-injury case file, digested once, shown twice: a brief that gets an attorney up to speed in ninety seconds, and a limited page for each medical provider treating the client. Everything on screen links back to the note, email or document page it came from.

Built for the Swans Applied AI Hackathon (Law-Di-Gras, San Diego, 2 October 2026) on the Sapini matter, read live from Clio Manage.

## Run it

You need Node 22.13 or newer. There is no build step.

```bash
npm install
cp .env.example .env     # add CLIO_ACCESS_TOKEN and ANTHROPIC_API_KEY
npm run doctor           # checks every Clio request and the AI key, read-only
npm start                # http://localhost:3000
```

Open the page and press **Pull the matter from Clio**. A first brief appears once the notes and emails are read. The page refreshes itself when the documents are done.

| Command | What it does |
|---|---|
| `npm start` | Runs the app |
| `npm run doctor` | Says exactly which Clio request or key is failing |
| `npm run sync` | Runs the same sync as the button, with progress in the terminal |
| `npm run sync -- --rebuild` | Reads every item again (use after changing a prompt) |

No Clio token yet? Create an app in Clio's developer portal, put its key and secret in `.env` as `CLIO_CLIENT_ID` and `CLIO_CLIENT_SECRET`, add `http://localhost:3000/clio/callback` as a redirect URI, and open `/clio/login`.

## What the attorney sees

In the order the trial lawyers we interviewed said they look:

1. **Header.** The client's photo (cropped from the photo ID in the intake folder), the filing deadline or the date suit was filed, when anyone last talked to the client, and how many tasks are overdue.
2. **Does the case hold up?** Fault, damages and coverage, each with a status and a plain explanation. Injuries are placed on a body outline and explained in words a twelve-year-old would follow.
3. **Money.** Case value, the recovery cap, medical bills, what the firm has spent, liens, wage loss.
4. **Needs attention.** Overdue, coming up, and waiting on someone else.
5. **Since you last opened.** What changed since this person's last visit.
6. **Where the file disagrees with itself.** Contradictions between entries, plus arithmetic checks.
7. **Treatment and bills.** One row per provider: still treating or not, last visit, records status, amount billed, whether a link was shared and opened. Sortable.
8. **The pitch.** The case in sixty seconds.
9. **The ten entries that matter**, with the full timeline one click behind.

Click any blue chip and a panel opens with the source: the note or email with the quoted passage highlighted, or the PDF at the cited page.

## What a provider sees

The attorney opens **Share review**, picks a provider, and gets a list of items, each with a proposed decision (share or withhold) and the reason. Items about the case are proposed by the AI. Items about the provider's own bills, records and patient are built by rule from that provider's row only. The attorney flips anything, adds a note, and creates a link. The preview beside the list is the exact card the provider will get.

The provider's page answers what providers asked for in the brief: is the case alive, what stage is it at, is there coverage, what does the firm hold from us, what does it need from us, is our patient still attending.

## How it works

```
Clio Manage API (GET only)
      │  matter + custom fields, contacts, notes, communications,
      │  tasks, calendar, case expenses, documents
      ▼
1. Pull      src/clio.js, src/pull.js
             Every item is stored with a content hash. PDFs are split into per-page text.
      ▼
2. Read      src/extract.js           (small model)
             Entries in small batches, documents in page ranges. Each fact is stored with
             the item, the page, and the exact quote that proves it. Pages with no text
             layer go to the vision model. An item is only read again if its hash changes.
      ▼
3. Write     src/synthesize.js        (larger model)
             Sees the fact ledger only, never raw documents. Must cite fact ids.
      ▼
4. Show      src/brief.js, src/views/*
             Resolves every cite to a source chip. Adds what plain code can compute.
      ▼
5. Share     src/shares.js
             Frozen, attorney-approved snapshot per provider behind an expiring link.
```

### Why the numbers can be trusted

- **Every statement cites its source.** A brief sentence with no valid fact id is dropped.
- **Quotes are checked.** Each AI fact carries a quote, and the app checks that the quote appears word for word in the source text. If the model names the wrong page, the fact is moved to the page that really contains the quote. The footer reports how many facts passed.
- **The model never adds up money.** Bill totals, firm costs and what is left under the cap are summed in code from Clio's own expense amounts.
- **Disagreement is shown, not hidden.** The brief lists contradictions in the file, and the app adds its own checks: bill totals that do not match the entries, and providers the file calls "still treating" whose records stop long ago.
- **No deadline is invented.** The model is told not to work out a limitations date from general legal knowledge. If the file does not state it, the page says so.

### What is AI and what is plain code

| Plain code, from Clio's structured data | AI, from the fact ledger |
|---|---|
| Overdue and upcoming tasks and calendar entries | Stage, status line, the pitch |
| Last contact with the client | Fault, coverage and damages assessments |
| Sums of bills and firm costs, the amount left under the cap | Injuries in plain language, with body region |
| Visit counts, last visit and gaps, from visit dates | Treatment and records status per provider |
| Changes since the last visit | Contradictions between entries |
| Mismatch checks between totals | Ranking of entries, and why each matters |
| Provider's own items on the share page | Share or withhold proposals about the case |

## Sharing: the security model

The file holds patient information, so the provider side is deliberately narrow.

- **Minimum necessary.** A provider's link carries the items the attorney approved and that provider's own bills and records. Nothing about other providers.
- **Snapshot, not access.** The link renders a frozen snapshot. The provider page has one route and no path into facts, notes or documents.
- **Unguessable, expiring, revocable.** Tokens are 24 random bytes. Only a SHA-256 hash is stored, so a link cannot be recovered from the database. Links expire (14 days by default) and can be revoked.
- **Logged.** Every open is recorded and shown to the firm.
- **Secrets stay out of the repo.** Tokens and keys live in `.env`. The database and downloaded documents live in `data/`. Both are ignored by git.

This is not a HIPAA-compliant deployment. A production version would add: a business associate agreement and zero data retention with the model provider, real sign-in for the firm's side (it is open on localhost today), a one-time code on top of provider links, encryption at rest, and audit logs for the firm's own reads.

## Models and cost

| Step | Default model | Setting |
|---|---|---|
| Reading entries and documents | `claude-haiku-4-5-20251001` | `EXTRACT_MODEL` |
| Writing the brief | `claude-sonnet-5-5` | `SYNTH_MODEL` |

The app measures cost instead of estimating it. Every call is logged with its token counts in the `llm_calls` table, and the footer of the brief shows the total for the case and for the last sync.

For the Sapini matter (about 190 items and 360 document pages) the first digest is roughly 65 calls. Our expectation is on the order of one dollar. Use the figure in the footer after your own run, not this estimate. A sync with nothing new makes no AI calls. A sync after one new note reads that note and rewrites the brief.

Prices are in `src/pricing.js`, matched by model name. They are list prices as we understood them on build day. Check them against the provider's pricing page, and override with `MODEL_PRICES` in `.env` if they differ. A model with no known price is reported in tokens only.

New API accounts have small per-minute limits. The app backs off and retries when told to slow down, so a first digest on a new account can take around ten minutes. On a higher tier it takes a couple of minutes.

## Tech stack

- **Built with:** Node 22, plain `node:http`, server-rendered HTML, a small amount of browser JavaScript. No framework and no build step.
- **Packages:** `pdfjs-dist` (page text) and `pdf-lib` (page splitting, photo extraction). Nothing else.
- **Runs on:** localhost.
- **Data outside Clio:** one SQLite file (`data/casebrief.db`, via Node's built-in `node:sqlite`) and the downloaded documents in `data/files/`.

| Table | Holds |
|---|---|
| `source_items` | Everything pulled from Clio, with content hashes and the AI's one-line summary and importance |
| `doc_pages` | Per-page text of each document |
| `facts` | Cited facts: type, detail, date, amount, page, quote, whether the quote was verified |
| `briefs` | The synthesised brief per matter |
| `views` | When the brief was opened, for "since you last opened" |
| `shares`, `share_opens` | Provider snapshots, token hashes, expiry, the open log |
| `runs`, `llm_calls` | Sync history, tokens and cost per call |

## The three rules

1. **One matter, read live.** The app finds the matter by `CLIO_MATTER_ID` or `CLIO_MATTER_QUERY` and pulls it from the Clio API. There is no other data path.
2. **Nothing hardcoded.** The code contains no case facts. Prompts are generic to personal-injury matters. Point the app at a different matter and it digests that one.
3. **Clio is input only.** `src/clio.js` sends GET requests to the API and nothing else. The only POST is the OAuth token exchange.

## Limits, stated plainly

- The firm's side has no sign-in. It is meant for localhost.
- Documents that are not PDFs, images or plain text are listed but not read.
- Pages beyond `MAX_DOC_PAGES` (200) in one document are not read, and the page says how many were skipped.
- If the fact ledger is longer than `LEDGER_CHARS`, the lowest-priority facts are left out of the brief-writing request (they stay in the database and the timeline). The default fits a new API account's limits.
- The body outline is a front view only.
- There are no automated tests. The pipeline was exercised end to end against local stand-ins for the Clio and model APIs before the first live run.

## Repo map

```
server.js              entry point, checks the Node version
src/config.js          environment
src/db.js              SQLite schema and helpers
src/clio.js            Clio API client (GET only) and OAuth
src/pull.js            pull a matter, hash and store every item
src/pdf.js             page text, page subsets, embedded photo
src/llm.js             model calls: retries, rate limits, cost log
src/pricing.js         price table
src/extract.js         facts from entries and documents
src/synthesize.js      the brief and the provider table
src/pipeline.js        the sync, with progress
src/brief.js           the page model: computed parts and resolved cites
src/shares.js          provider links
src/app.js             routes
src/views/             HTML for each page
public/                one stylesheet, one script
scripts/doctor.js      setup check
scripts/sync.js        sync from the terminal
```
