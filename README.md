# CaseBrief

A ninety-second digest of one personal-injury matter, read live from Clio Manage. Built for the Swans Applied AI Hackathon (Law-Di-Gras, San Diego, 2 October 2026) on the Sapini matter.

Work in progress today. This file is rewritten as features land.

## Run it

You need Node 22.13 or newer.

```bash
npm install
cp .env.example .env      # then fill in the Clio token and the AI key
npm run doctor            # checks Clio and the AI key, read-only
npm start                 # http://localhost:3000
```

## Rules we hold ourselves to

- **Clio is input only.** `src/clio.js` sends GET requests and nothing else to the Clio API.
- **Nothing about the case is written into the code.** Every figure on screen comes from the Clio pull and the digest, and links back to the note, email or page it came from.
- **Our data lives outside Clio**, in one SQLite file under `data/` (ignored by git).
