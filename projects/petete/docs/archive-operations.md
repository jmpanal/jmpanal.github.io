# Durable DGT archive without Cloudflare access

The source archive can collect official DGT rulings before Cloudflare credentials are available. It uses the repository's built-in `GITHUB_TOKEN`, serial requests to the official DGT website, and the separate `petete-data` branch. It requires no paid data API, Cloudflare token or AI key. It does not include CENDOJ data.

The repository is public. The data branch contains public DGT source documents and collection metadata. No user accounts, credentials or private legal matters belong in that branch.

## Starting and observing collection

The workflow template is `.github/workflows/archive.yml`. In the containing repository it must be installed in the repository-root `.github/workflows/` directory, with the source project at `projects/petete`.

A normal push to `main` that changes `projects/petete/**` or an archive workflow starts collection. The workflow also supports **Run workflow** in GitHub Actions and an hourly schedule at minute 17 UTC. It never changes `main` or the personal website's files. If `petete-data` does not exist, it creates the branch from the checked-out source commit; only `archive/` is subsequently added or updated there.

The first run is limited to 60 source documents or three minutes, whichever is reached first. Later runs are limited to 2,000 documents or 30 minutes. Requests are serial and spaced at least 1.2 seconds apart. The time limit is soft: a request already in progress can finish, with a 30-second request timeout. The workflow allows additional time for installation, verification and publication. No corpus size or completion date is assumed.

Read the Actions run summary and `petete-data/archive/manifest.json` for actual progress. Its statistics distinguish:

- Unique DGT references retained in the source archive.
- Stored source versions, which can exceed the unique count after revisions.
- Historical month/database windows that have reconciled against official source counts.
- Whether every historical window in the stated query range has completed.

Official DGT results can include canceled consultation numbers. These notices are preserved with `documentKind: cancellation_notice` so result-count reconciliation remains exact. The manifest reports `rulings` and `cancellationNotices` separately; `uniqueDocuments` includes both. A cancellation notice has no substantive answer. Its application summary is the literal source notice with status `source_notice`, its embedding state is `not_applicable`, and it is excluded from AI summary generation and semantic embedding. Exact number lookup remains available.

The historical query range is fixed when the first manifest is created. It starts on January 1, 1997 and ends on that run's date. A monthly campaign is created automatically when the collector first runs in a new UTC month. It refreshes the current month and two preceding months, ahead of the historical backfill. This overlap handles ordinary late publication within that interval. A correction published with an older ruling date requires an explicit additional historical refresh; the overlap is not a guarantee that all older revisions will be discovered.

The official publication cutoff is separate from the calendar query range. `source.publicationCutoff` remains `null` unless independently verified for the snapshot. A query ending today does not establish that DGT has published today's documents.

**Archived, imported into Cloudflare, summarized by AI, and embedded for semantic search are separate states.** Completing this workflow establishes only source collection for its reconciled windows. It does not activate web application logins or populate Cloudflare automatically.

## Transactional storage

The data branch contains:

```text
archive/manifest.json
archive/corpus/YYYY-MM/1/<sha256>.jsonl.gz
archive/corpus/YYYY-MM/2/<sha256>.jsonl.gz
archive/indexes/YYYY-MM/1/<sha256>.json
archive/indexes/YYYY-MM/2/<sha256>.json
```

Database `1` is DGT general consultations and `2` is binding consultations. Gzip batches contain complete normalized source documents, their official references, source links and retrieval provenance. Each raw batch is at most 8 MiB and contains at most 25 records. Reference indexes point to the latest stored version of each ruling, with its checksum, shard and position. Unchanged source text is not duplicated merely because it was retrieved again.

The collector writes immutable shards first, immutable reference indexes second, and the manifest checkpoint last. A crash between these writes leaves the previous manifest and its referenced files valid. Orphan temporary output is removed before publication. A successful checkpoint contains both the updated cursor and the documents that justify advancing it.

Before pushing, verification checks index and shard checksums, gzip content, document identity and metadata, reference pointers, source window reconciliation, complete historical window continuity and counts. Verification processes one decompressed shard at a time. A corrupt or incomplete snapshot cannot be published as complete.

A single Git commit publishes all changed data, indexes and the checkpoint together. Workflow concurrency allows one archive writer at a time. The push uses a normal fast-forward, so an unexpected concurrent branch update causes failure rather than overwriting another writer. Restoring the latest successful `petete-data` commit restores a consistent corpus and cursor. A hard runner interruption before publication can lose that run's unpublished progress, which is safely fetched again.

The collector's logical cursor can advance within a reconciliation pass or start a later reconciliation round. It cannot move backward within the same round. A source-count mismatch causes another pass; after persistent mismatch it remains incomplete. HTTP failures, unexpected HTML, missing pagination and incomplete documents never become successful empty windows.

## Source failures and retries

A source failure stops the run after flushing its last valid documents and cursor. The workflow still verifies and publishes that valid checkpoint, then reports the collection failure in Actions. This preserves useful work without hiding the failure.

Retries back off exponentially. After six failures a window is marked `blocked` and needs investigation. A blocked window does not count as collected. The manifest retains its source range, exact page cursor, attempts and error. Fix a changed parser or an access problem before resetting a blocked window. Do not skip it or reduce the declared historical range to make coverage appear complete.

To recover a blocked window after fixing the cause, clone the data branch, change only that window's `status` to `queued`, `attempts` to `0`, and `retryAt` to `null`, clear the global `nextSourceAttemptAt` and `consecutiveSourceFailures`, then run deep verification before committing. Retain its cursor and collected-reference set. Never reset them independently from their corresponding source data.

## Exporting and importing into the application

After checking out the data branch separately, export the latest stored source revision per reference:

```sh
node scripts/archive-export.mjs \
  --dir /path/to/petete-data/archive \
  --output /path/to/dgt-latest.jsonl
```

Then, once Cloudflare is configured and an administrator account exists:

```sh
python scripts/dgt-import.py \
  --url https://www.jmpanal.com/petete \
  --email YOUR_ADMIN_EMAIL \
  --file /path/to/dgt-latest.jsonl
```

The importer prompts for the password without echo. Imports are idempotent. Importing the source records does not complete AI summaries or vector indexing. Monitor the application's coverage and enrichment states separately.

To verify an existing archive without contacting DGT:

```sh
node scripts/archive-verify.mjs --dir /path/to/petete-data/archive
```

To run collection on an operator machine with the same durable archive directory:

```sh
node --experimental-transform-types scripts/archive-collect.mjs \
  --dir /path/to/petete-data/archive \
  --max-seconds 1800 \
  --max-documents 2000
```

Commit and push the verified data directory together with its manifest. Do not run a local writer against the same branch while the scheduled writer is active.

## GitHub scheduling limits

GitHub can delay scheduled runs. The schedule operates from the default branch, and public repositories can have scheduled workflows disabled after 60 days without repository activity. Review the Actions page if collection stops. The workflow supports manual runs and source-change pushes so it can be restarted after investigating a missed schedule.

Data commits made with `GITHUB_TOKEN` do not recursively trigger ordinary push workflows or GitHub Pages builds. The workflow additionally filters its push trigger to `main`. No Cloudflare deployment is performed by the archive workflow.

Official GitHub references:

- [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GITHUB_TOKEN behavior](https://docs.github.com/en/actions/concepts/security/github_token)

## Verification included in the project

Run `node --test scripts/archive-store.test.mjs scripts/archive-runner.test.mjs`. Tests inject failures after shard writes, after index writes and before manifest publication. They verify that the prior snapshot remains valid, and exercise source revisions, duplicate retrieval, corruption detection, count reconciliation, monthly priority, run budgets, checkpoint resumption and failure preservation. These tests do not claim the full archive is already collected.
