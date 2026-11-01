#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { appendFile } from "node:fs/promises";
import { DgtClient } from "../worker/dgt.ts";
import { ArchiveStore, verifyArchive } from "./archive-store.mjs";
import { runArchive } from "./archive-runner.mjs";
const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    "max-seconds": { type: "string", default: "1800" },
    "max-documents": { type: "string", default: "2000" },
    "bootstrap-seconds": { type: "string", default: "180" },
    "bootstrap-documents": { type: "string", default: "60" },
    "interval-ms": { type: "string", default: "1200" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --experimental-transform-types scripts/archive-collect.mjs --dir PATH [--max-seconds 1800] [--max-documents 2000] [--bootstrap-seconds 180] [--bootstrap-documents 60] [--interval-ms 1200]",
  );
  process.exit(0);
}
if (!values.dir)
  throw new Error(
    "--dir must identify the separate petete-data archive directory.",
  );
const root = resolve(values.dir),
  store = await ArchiveStore.open(root),
  bootstrap = !store.manifest.lastRun;
if (!bootstrap) await verifyArchive(root, { deep: false });
store.ensureMonthly(new Date().toISOString().slice(0, 10));
const interval = Number(values["interval-ms"]);
if (!Number.isFinite(interval) || interval < 1200)
  throw new Error("Source interval must be at least 1200 milliseconds.");
const maxSeconds = Number(
    values[bootstrap ? "bootstrap-seconds" : "max-seconds"],
  ),
  maxDocuments = Number(
    values[bootstrap ? "bootstrap-documents" : "max-documents"],
  );
if (
  !Number.isFinite(maxSeconds) ||
  maxSeconds < 1 ||
  maxSeconds > 1800 ||
  !Number.isInteger(maxDocuments) ||
  maxDocuments < 1 ||
  maxDocuments > 2000
)
  throw new Error("Maximum run limits are 1800 seconds and 2000 documents.");
let result;
try {
  result = await runArchive({
    store,
    client: new DgtClient(fetch, interval),
    maxSeconds,
    maxDocuments,
    onProgress: (progress) => console.log(JSON.stringify(progress)),
  });
} catch (error) {
  console.error("Archive persistence or verification failed:", String(error));
  process.exitCode = 1;
  throw error;
}
console.log(
  JSON.stringify({
    run: result,
    statistics: store.manifest.statistics,
    historicalQueryRange: store.manifest.historical,
    publicationCutoff: store.manifest.source.publicationCutoff,
    note: "Archived is separate from imported into the web application, AI summarized, and semantically indexed.",
  }),
);
if (process.env.GITHUB_STEP_SUMMARY) {
  const s = store.manifest.statistics;
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## DGT archive collection\n\nRun: ${result.status}. Stored source records: ${s.uniqueDocuments} (${s.rulings ?? s.uniqueDocuments} rulings, ${s.cancellationNotices || 0} official canceled-number notices). Historical windows reconciled: ${s.historicalWindowsComplete}/${s.historicalWindowsTotal}.\n\nHistorical query range: ${store.manifest.historical.from} through ${store.manifest.historical.to}. Complete: ${s.historicalComplete ? "yes" : "no"}. Official publication cutoff: unverified for this snapshot.\n\nThe archive branch contains public DGT source documents. These counts do not establish Cloudflare import, AI summary, or semantic-index completion.\n${result.error ? "\nA source or integrity failure was recorded in archive/manifest.json. The cursor was preserved for investigation and retry.\n" : ""}`,
  );
}
if (["failed", "blocked"].includes(result.status)) process.exitCode = 1;
