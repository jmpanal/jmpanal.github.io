# DGT collection and AI indexing

The application distinguishes the verified demo sample from the production database. It does not claim that 1997 through today has been collected until the source windows have finished and their document counts reconcile. A queue existing in D1 is not evidence of completed coverage. Source publication also lags the calendar: the official DGT form inspected on October 31, 2026 listed an update through September 30, 2026.

## What is collected

DGT has separate general and binding databases. Each calendar month is searched in both databases. The collector derives document IDs from actual search responses. It never guesses consultation numbers, and it does not interpret numbering gaps as missing documents.

The verified source protocol is:

1. Initialize the same session at `https://petete.tributos.hacienda.gob.es/consultas/` and `/consultas/do/form`.
2. POST the date range to `/consultas/do/search`, with `NMCMP_2=FECHA-SALIDA`, `VLCMP_2=dd/mm/yyyy..dd/mm/yyyy`, `tab=1` for general or `tab=2` for binding, and page/order fields.
3. Read the exact query, total count, page count and document IDs returned by the source.
4. POST the returned query and document ID to `/consultas/do/document`, preserving the source session and AJAX headers.
5. Store the complete answer, facts, question, legislation and issuing body. The stable source link uses `?num_consulta=<official reference>`.

The parser rejects missing counts, missing IDs, malformed dates, incomplete answers, inconsistent empty responses, and missing pagination for a multipage result. HTTP errors become visible failed or retrying jobs. They never become a successful empty archive window. Paragraphs, tables and list text are retained.

Within a job, unique document references are reconciled against the source count before completion. If pagination changed, up to two extra passes are attempted. A persistent mismatch remains a failed job for investigation.

## Hosted collection

Apply every migration in order before starting collection. `0002_ingestion.sql` adds ingestion cursors, chunk provenance, retry state and vector cleanup.

An administrator can enqueue the historical range using the panel or:

```sh
python scripts/dgt-backfill.py \
  --url https://www.jmpanal.com/petete \
  --email YOUR_ADMIN_EMAIL \
  --from-date 1997-01-01 \
  --to-date 2026-10-31
```

The password is prompted without echo. The script authenticates, queues work, and logs out. Use the date of the actual run rather than copying an old end date.

The periodic cron drains a bounded number of documents from the queue. `INGESTION_BATCH_SIZE` accepts an integer from 1 through 20, with a default of 3. The source client sends requests serially at least 1.2 seconds apart. Larger batches require checking actual source response time, Worker execution limits and resource usage.

The monthly cron is `0 4 1 * *`, evaluated in UTC. It queues the current month and two preceding calendar months to pick up late publication. Monthly jobs take priority over the historical archive. This prevents a long backfill from delaying new rulings. Cron declarations must match the handler; the integration test checks the configured monthly cron.

Jobs use leases so overlapping invocations do not knowingly process the same active cursor. Failed requests back off exponentially. After six failures a job remains failed until an administrator retries it. The job record retains the error and source window. Importing the same unchanged source is idempotent; a changed source invalidates its prior summary and embedding chunks.

The initial archive is a background operation. Its completion time must be measured from the source's actual count and observed throughput. The project does not promise a collection duration or invent a total number of rulings.

## Controlled archive harvest on an operator machine

For an initial archive transfer, the standalone harvester uses the same source parser and can run continuously without waiting between scheduled Worker invocations. It requires Node 22 or newer, the installed project dependencies, and Node's native TypeScript transformation flag.

```sh
node --experimental-transform-types scripts/dgt-harvest.mjs \
  --from 1997-01-01 \
  --to 2026-10-31 \
  --output data/harvest/rulings.jsonl \
  --max-documents 1000 \
  --interval-ms 1200
```

Repeat the exact same command to resume. An atomic checkpoint sits beside the JSONL output. Keep that checkpoint with its corresponding output. The harvester refuses to resume with a different date range or output path. It stops at the document limit, source failure, or reconciled completion. An interrupted append can produce a duplicate line, which the importer handles idempotently. A paused or failed status does not mean complete coverage.

Import the resulting JSONL with an administrator session:

```sh
python scripts/dgt-import.py \
  --url https://www.jmpanal.com/petete \
  --email YOUR_ADMIN_EMAIL \
  --file data/harvest/rulings.jsonl
```

The importer sends one document per request. Its success means the document was stored; it does not mean AI enrichment is finished. Keep large harvested files and checkpoints outside the Git source history. Back them up using the deployment operator's durable storage.

## AI summaries and semantic indexing

Workers AI and Vectorize are optional runtime bindings. Without them, the application reports keyword search and pending AI work. It does not label a keyword fallback as semantic search.

Each complete ruling is split into overlapping text chunks. No end-of-document truncation is used. Embeddings use `@cf/baai/bge-m3` and a 1024-dimensional Vectorize index. Vector IDs map back to document chunks in D1; search must resolve that mapping before rendering a ruling.

Summaries use `@cf/meta/llama-3.1-8b-instruct`. Each chunk is summarized, then chunk summaries are combined. Long documents use cached intermediate synthesis so they can resume across invocations. The summary stores its model, generation time and source content hash. A summary with an unsupported consultation reference is rejected. The official reference and link are taken from the source record, not generated by AI.

AI outputs remain fallible. The interface asks users to verify the source. Date ordering helps investigation but never establishes that a legal position changed or remains current. The app does not generate a claim of changed criteria from chronology alone.

AI failures are counted before the model call and have per-chunk backoff. A failing early document cannot permanently starve later documents. Repeatedly failed chunks or synthesis remain visible as pending/error work until the cause is fixed and their retry state is reset. Old Vectorize chunks from a replaced document enter a durable cleanup queue; scheduled cleanup removes them to avoid stale vectors consuming search matches.

Workers AI, Vectorize and D1 usage may incur provider charges. Configure and monitor provider limits before a full archive run. No fixed cost estimate is supplied without corpus size, chunk counts and measured usage.

## CENDOJ

The application does not scrape or bulk download CENDOJ. The official search remains available as an external search path. Integrated document search and AI summaries operate only on lawfully imported records.

A CENDOJ JSONL import must include the official reference, ISO date, title, complete text and an HTTPS source link on `poderjudicial.es`. The administrator must already hold the necessary reuse authorization. Pass its written agreement/reference explicitly:

```sh
python scripts/dgt-import.py \
  --url https://www.jmpanal.com/petete \
  --email YOUR_ADMIN_EMAIL \
  --file authorized-cendoj.jsonl \
  --permission-reference 'YOUR_WRITTEN_AUTHORIZATION_REFERENCE'
```

The permission reference is stored as provenance. Supplying this field is an operator attestation, not an automatic grant of rights or verification by CENDOJ. Do not use it to import documents without the relevant authorization.

## Verification

`tests/ingestion.test.ts` includes official DGT search and full-document fixtures. It verifies source IDs, metadata, complete text, table/list retention, source cookies, date windows, failed-source handling, strict pagination, chunk coverage, deterministic hashes and CENDOJ permission checks. Integration tests exercise real SQLite migrations and source queue behavior without claiming a live full-corpus crawl or live AI evaluation.
