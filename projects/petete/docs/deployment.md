# Deployment and operations

## Scope

Production URL: `https://www.jmpanal.com/petete/`. Deploy a separate Cloudflare Worker on the two configured route patterns, leaving the current site and root routes untouched. A Pages project or its Git integration is not required. The zone must exist in the Cloudflare account used for deployment, with proxied DNS for `www`.

This work does not include the complete historical DGT corpus. Code deployment, corpus collection, AI enrichment and source-coverage reconciliation are separate observable states. Current public source publication may lag calendar time.

## First deployment

From `projects/petete` in the repository:

1. Install Node24, run `npm ci`, then `npm test` and `npm run build`.
2. Authenticate using `npx wrangler login`, or configure scoped Cloudflare credentials locally. Never commit tokens or paste them into chat.
3. Run `npm run setup:cloudflare`. It reuses matching D1/Vectorize resource names and records the non-secret D1 ID in `wrangler.jsonc`. Review that the selected account and zone are correct. D1 is requested with EU jurisdiction; this does not mean that all AI processing or logs are restricted to the EU.
4. Run `node scripts/create-admin.mjs`. It prompts for an email, name and hidden password of at least12 characters. A random bootstrap token travels through stdin to Cloudflare, and the API atomically allows only the first administrator. There is no default login.
5. Sign in at the production URL. Confirm the user administration, source coverage and job panels work. Inspect `GET /petete/api/health` for binding status.
6. Start the desired historical range from Administration. Check failed jobs, duplicate reconciliation and source cutoffs. Prioritize current publications when a historical run is still pending.
7. Confirm monthly cron `0 4 1 * *` and queue-drain cron `*/5 * * * *` are active. Cloudflare schedules are UTC; the monthly run is06:00 in Madrid summer time and05:00 winter time.

`SESSION_PEPPER` is mandatory for user login. `ADMIN_BOOTSTRAP_TOKEN` is only needed for first-admin initialization. Rotate or remove the bootstrap secret after setup if desired; the initialized database rejects further bootstrap calls regardless.

## GitHub deployment

Full source is stored under `projects/petete`; the source folder includes workflow templates. The root workflows run checks for changes under that path. To enable manual production deployments, configure environment `petete-production` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and commit the actual non-secret D1 ID after first provisioning. The token needs access to the named Worker, D1, Vectorize, AI and the `jmpanal.com` route. Limit it to the relevant account and zone.

The deployment script refuses the dummy D1 ID, reruns tests/build, applies migrations and publishes the Worker. Do not publish before reviewing migration compatibility. `npm run setup:cloudflare` does not purchase a paid plan. If your account requires a plan change, stop and review that change yourself.

## Data controls

DGT collection is serial with bounded batches, source sessions, retry/backoff and parser validation. Initial throughput must be measured against the actual site; do not assume an import finish date. The Python collector supports a durable checkpoint and JSONL output for a controlled initial load. Authorized imports go through an admin session; no public ingestion token is embedded in the browser.

CENDOJ imports require a recorded written-authorization reference. This check records the operator's assertion; it cannot verify the underlying agreement. Obtain the appropriate authorization and permitted source files before importing. The public CENDOJ search link remains useful while that is pending.

Workers AI and Vectorize require the configured account services and incur usage under the account's current plan. Enrichment failures remain visible and retriable. The demo uses reviewed editorial summaries and keyword search; it must never be described as a fully indexed semantic archive.

## Monitoring and recovery

Use Cloudflare Worker logs, `GET /health`, coverage and Administration jobs/audit. A failed source fetch does not count as an empty source window. Retry failed jobs only after reviewing the recorded error. The immutable original source link and content hash are retained with documents; summaries include provenance.

D1 recovery/backup options depend on the account plan. Verify available Time Travel retention and a tested export/restore procedure before storing production user data. Do not assume backups from a successful deployment alone.

Block/cancel revokes active sessions. Multiple network aliases or user agents are review signals, not proof of sharing. The application uses hashed network identifiers and does not store the raw IP. Restrict administrative access and define a retention policy appropriate for your deployment.

To remove Petete routing, remove only its two Worker routes. The current root website stays hosted by its existing service. Use Cloudflare's previous Worker version for code rollback; database migrations are forward-only and require a separate recovery plan if incompatible.
