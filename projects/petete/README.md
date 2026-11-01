# Petete

Spanish tax research application designed for `https://www.jmpanal.com/petete/`.

React/Vite frontend, Cloudflare Worker API, D1/FTS5 storage, Workers AI summaries and multilingual BGE-M3 embeddings, Vectorize retrieval. The Worker mounts only `/petete` and `/petete/*`, preserving the existing website.

## What is implemented

| Requirement | Implementation | Activation dependency |
| --- | --- | --- |
| DGT rulings from 1997 | Date-window collector for general and binding consultations; session/cookie handling; resumable checkpoints; unique-document reconciliation | Run the initial historical backfill. The full corpus is **not included** in this repository. |
| Monthly updates | First day of each month at 04:00 UTC, with overlapping publication windows; a separate five-minute job drains the queue | Deployed Worker cron and D1 |
| Meaning-based search | Full-text chunks, multilingual1024-dimensional BGE-M3 embeddings, Vectorize plus FTS ranking; explicit fallback and retrieval limits | Workers AI, Vectorize and completed indexing |
| Ruling summaries and citations | Hierarchical source-grounded summaries, stored model/time/source hash; citations come from source metadata | AI enrichment; demo summaries are explicitly editorial |
| Chronological review | Date ordering across full lexical results, document reader and timeline | Imported documents. Chronology does not itself establish changed doctrine. |
| CENDOJ | Official-search handoff and authorized full-document import, number/date/text/summary | Written CENDOJ reuse authorization and permitted data. No unauthorized scraper is included. |
| Excel | Real `.xlsx` export with references, source URLs, summary type and export-scope sheet; formula-injection protection | No external spreadsheet account |
| Desktop and mobile | Responsive library, reading panel, filters, bookmarks and accessible forms | Frontend build |
| User login | PBKDF2 passwords, opaque hashed sessions, Secure/HttpOnly/SameSite cookies, same-origin writes, login throttling | D1 and `SESSION_PEPPER` secret |
| Administration | Create/block/cancel/reactivate users, reset passwords, revoke sessions, inspect network/device sharing signals and audit events | Administrator account |
| Deployment | Scoped Worker routes, SQL migrations, provisioning script, build/tests, GitHub Actions templates | Cloudflare account access; production database ID |
| Guide and onboarding | Spanish user guide, operator runbook and two guided walkthrough agendas | Live calls are not included or scheduled by this repository. |
| Free demo | Nine verified full-text DGT documents spanning 1997–2026; browser text search/bookmarks/Excel; no default password | Runs statically, without an AI provider key |

The DGT site stated a latest publication cutoff of **2026-09-30** when researched on2026-10-31. This is a website parser, not an official API. See [source research](docs/source-research.md). No retrieval system guarantees that every relevant ruling is returned. The interface exposes corpus and indexing limitations instead of presenting an incomplete index as exhaustive.

## Local development

Requires Node24 and Python3 for collector CLI tools. Run commands from this directory:

```sh
npm ci
npm test
npm run build
npm run db:migrate:local
node scripts/seed-demo.mjs
npx wrangler d1 execute petete --local --config wrangler.local.jsonc --file .tmp/demo-seed.sql
npm run worker:dev
```

The full local app is served by Wrangler at its printed URL followed by `/petete/`. No production credentials or default accounts are included. For frontend hot reload, run `npm run dev` in another terminal; API requests proxy to Wrangler on8787. The public demo works without signing in. AI is intentionally unbound in the local configuration; lexical fallback is visible.

## Cloudflare deployment

For deployment from your own browser using GitHub secrets, follow [this short guide](docs/deploy-from-your-browser.md). This route does not require a shared browser login, a local terminal, or committing a production database ID. The workflow provisions resources, initializes the first administrator and queues the historical import.


See [deployment runbook](docs/deployment.md). The production configuration contains a clearly invalid local-only D1 ID until provisioning replaces it. `npm run deploy` refuses to deploy that ID.

```sh
npx wrangler login
npm run setup:cloudflare
node scripts/create-admin.mjs
```

The setup command creates or reuses the `petete` D1 database and `petete-bge-m3` Vectorize index, verifies its dimensions and filtering metadata, applies migrations, seeds nine real production documents with pending AI work, and deploys the application. D1 creation requests EU jurisdiction. It uses your existing Cloudflare account and does not change the domain's nameservers or replace root-page content. Cloudflare usage charges depend on your plan, corpus size and AI workload. No paid plan is purchased by this code.

After signing in as administrator, import the desired dates from **Administración**, inspect job failures and indexing state, and reconcile each source window before relying on coverage. Do not mark the database complete based only on row counts.

## Durable historical collection

The `Petete DGT source archive` GitHub workflow starts on project changes, then resumes hourly. It publishes compressed official-source documents and their verified checkpoints atomically to the separate `petete-data` branch. Monthly refresh windows have priority over historical work. No Cloudflare secret is required for this collection. See [archive operations](docs/archive-operations.md). Archived, imported, AI summarized and semantically indexed are distinct states. A running workflow does not mean the historical archive is complete.

## Repository layout

- `src/`: user interface and local demo behavior.
- `worker/`: authenticated API, retrieval, source adapter and scheduled ingestion.
- `migrations/`: ordered D1 migrations; apply **all** files.
- `data/seed-real.json`: verified demo documents with official attribution.
- `scripts/`: provisioning, admin initialization, source collector and importer.
- `tests/`: authentication, SQL/FTS integration, ingestion and source fixtures.
- `docs/`: source research, deployment, ingestion, user guide and verification.

GitHub workflow files in this source folder are templates. When this app lives under `projects/petete`, copy them to the repository root `.github/workflows/` to activate them. CI has read-only repository permissions. The deploy workflow is manual and uses environment-scoped Cloudflare secrets.
