import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ArchiveStore,
  verifyArchive,
  latestDocuments,
} from "./archive-store.mjs";
import { runArchive } from "./archive-runner.mjs";
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "petete-archive-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ArchiveStore.open(root, { today: "1997-01-31" });
  return { root, store };
}
const record = (ref = "0001-97") => ({
  source: "dgt",
  reference: ref,
  date: "1997-01-03",
  title: "Consulta tributaria",
  text: "Texto oficial completo que expresa un criterio tributario verificable.",
  source_url: `https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=${ref}`,
  tax: "IVA",
  binding: 0,
});
function source({ total = 2, failDocument = null, tick = () => {} } = {}) {
  const calls = { search: [], document: [] };
  return {
    calls,
    async search(from, to, tab, page) {
      tick("search");
      calls.search.push({ from, to, tab, page });
      return {
        query: "official query",
        order: "FECHA-SALIDA|0",
        page,
        total: tab === 1 ? total : 0,
        totalPages: tab === 1 ? 1 : 0,
        documentIds: tab === 1 ? ["1", "2"] : [],
      };
    },
    async document(id, tab) {
      tick("document");
      calls.document.push({ id, tab });
      if (id === failDocument)
        throw new Error("DGT HTTP 503; not an empty source.");
      return record(id === "1" ? "0001-97" : "0002-97");
    },
  };
}
async function docs(root) {
  const rows = [];
  for await (const row of latestDocuments(root)) rows.push(row);
  return rows;
}

test("a document budget saves a resumable cursor with its data, then resumes at the next source ID", async (t) => {
  const { root, store } = await setup(t),
    client = source();
  const first = await runArchive({
    store,
    client,
    maxSeconds: 10,
    maxDocuments: 1,
  });
  assert.equal(first.status, "paused");
  assert.equal(first.fetched, 1);
  assert.equal((await verifyArchive(root)).records, 1);
  assert.deepEqual(
    client.calls.document.map((x) => x.id),
    ["1"],
  );
  const restored = await ArchiveStore.open(root);
  assert.equal(restored.nextWindow().cursor.nextDocument, 1);
  const second = await runArchive({
    store: restored,
    client,
    maxSeconds: 10,
    maxDocuments: 1,
  });
  assert.equal(second.fetched, 1);
  assert.deepEqual(
    client.calls.document.map((x) => x.id),
    ["1", "2"],
  );
  assert.equal((await verifyArchive(root)).records, 2);
  assert.equal(
    restored.manifest.windows.find((w) => w.tab === 1).status,
    "completed",
  );
  const final = await runArchive({
    store: restored,
    client,
    maxSeconds: 10,
    maxDocuments: 1,
  });
  assert.equal(final.status, "up_to_date");
  assert.equal(final.fetched, 0);
  assert.equal(
    (await verifyArchive(root)).manifest.statistics.historicalComplete,
    true,
  );
  assert.deepEqual(
    (await docs(root)).map((x) => x.reference),
    ["0001-97", "0002-97"],
  );
});

test("a time budget finishes the in-flight request, persists it, and pauses without claiming completion", async (t) => {
  const { root, store } = await setup(t);
  let now = Date.parse("2026-11-01T00:00:00Z");
  const client = source({
    tick: () => {
      now += 1500;
    },
  });
  const result = await runArchive({
    store,
    client,
    maxSeconds: 2,
    maxDocuments: 100,
    clock: () => now,
  });
  assert.equal(result.status, "paused");
  assert.equal(result.fetched, 1);
  assert.equal(client.calls.document.length, 1);
  assert.equal((await verifyArchive(root)).records, 1);
  assert.equal(
    store.manifest.windows.find((w) => w.tab === 1).status,
    "active",
  );
  assert.equal(store.manifest.statistics.historicalComplete, false);
});

test("source failure preserves the prior successful record and retries without falsely recording an empty window", async (t) => {
  const { root, store } = await setup(t);
  let now = Date.parse("2026-11-01T00:00:00Z");
  const client = source({ failDocument: "2" });
  const failed = await runArchive({
    store,
    client,
    maxSeconds: 10,
    maxDocuments: 100,
    clock: () => now,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.fetched, 1);
  assert.match(failed.error, /503/);
  const verified = await verifyArchive(root);
  assert.equal(verified.records, 1);
  const window = verified.manifest.windows.find((w) => w.tab === 1);
  assert.equal(window.status, "retry");
  assert.equal(window.sourceTotal, 2);
  assert.equal(window.cursor.nextDocument, 1);
  assert.equal(window.verifiedCount, 0);
  const searches = client.calls.search.length;
  const waiting = await runArchive({
    store: await ArchiveStore.open(root),
    client,
    maxSeconds: 10,
    maxDocuments: 1,
    clock: () => now,
  });
  assert.equal(waiting.status, "waiting_retry");
  assert.equal(client.calls.search.length, searches);
  now += 16 * 60 * 1000;
  const healthy = source();
  const resumedStore = await ArchiveStore.open(root);
  const resumed = await runArchive({
    store: resumedStore,
    client: healthy,
    maxSeconds: 10,
    maxDocuments: 1,
    clock: () => now,
  });
  assert.equal(resumed.fetched, 1);
  assert.deepEqual(
    healthy.calls.document.map((x) => x.id),
    ["2"],
  );
  assert.equal((await verifyArchive(root)).records, 2);
});

test("a source count mismatch gets reconciliation passes, then remains incomplete with a visible failure", async (t) => {
  const { root, store } = await setup(t);
  const result = await runArchive({
    store,
    client: source({ total: 3 }),
    maxSeconds: 10,
    maxDocuments: 100,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /Reconciliation failed/);
  const verified = await verifyArchive(root),
    window = verified.manifest.windows.find((w) => w.tab === 1);
  assert.notEqual(window.status, "completed");
  assert.equal(window.sourceTotal, 3);
  assert.equal(window.seenReferences.length, 2);
  assert.equal(window.verifiedCount, 0);
  assert.equal(verified.manifest.statistics.historicalComplete, false);
  assert.equal(verified.records, 2);
});

test("monthly work runs before historical windows even while the initial archive is unfinished", async (t) => {
  const { root, store } = await setup(t);
  store.ensureMonthly("2026-11-01");
  let now = Date.parse("2026-11-01T00:00:00Z");
  const requests = [];
  const client = {
    async search(from, to, tab, page) {
      requests.push({ from, to, tab, page });
      now += 1200;
      return {
        query: "",
        order: "",
        page,
        total: 0,
        totalPages: 0,
        documentIds: [],
      };
    },
    async document() {
      throw new Error("Unexpected document fetch for empty source.");
    },
  };
  const result = await runArchive({
    store,
    client,
    maxSeconds: 2,
    maxDocuments: 1,
    clock: () => now,
  });
  assert.equal(result.status, "paused");
  assert.equal(requests[0].from, "2026-11-01");
  assert.equal(requests[0].tab, 1);
  assert.ok(
    store.manifest.windows
      .filter((w) => w.campaign === "historical")
      .every((w) => w.status === "queued"),
  );
  await verifyArchive(root);
});

test("permanently blocked jobs are reported as blocked rather than waiting for an automatic retry that cannot happen", async (t) => {
  const { root, store } = await setup(t);
  for (const w of store.manifest.windows) {
    w.status = "blocked";
    w.attempts = 6;
    w.error = "Manual source review required.";
  }
  const client = {
    async search() {
      throw new Error("Blocked jobs must not query source.");
    },
  };
  const result = await runArchive({
    store,
    client,
    maxSeconds: 2,
    maxDocuments: 1,
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    (await verifyArchive(root)).manifest.statistics.historicalComplete,
    false,
  );
});

test("a valid empty source response clears previous transient source-failure backoff", async (t) => {
  const { root, store } = await setup(t);
  store.manifest.consecutiveSourceFailures = 3;
  store.manifest.nextSourceAttemptAt = "2026-10-01T00:00:00Z";
  const client = {
    async search(from, to, tab, page) {
      return {
        query: "",
        order: "",
        page,
        total: 0,
        totalPages: 0,
        documentIds: [],
      };
    },
  };
  const result = await runArchive({
    store,
    client,
    maxSeconds: 2,
    maxDocuments: 1,
    clock: () => Date.parse("2026-11-01T00:00:00Z"),
  });
  assert.equal(result.status, "up_to_date");
  assert.equal(store.manifest.consecutiveSourceFailures, 0);
  assert.equal(store.manifest.nextSourceAttemptAt, null);
  await verifyArchive(root);
});

test("a successful nonempty search does not reset backoff when document authorization keeps failing", async (t) => {
  const { root, store } = await setup(t);
  let now = Date.parse("2026-11-01T00:00:00Z");
  store.manifest.consecutiveSourceFailures = 2;
  store.manifest.nextSourceAttemptAt = "2026-10-31T23:00:00Z";
  let searches = 0,
    documents = 0;
  const client = {
    async search(from, to, tab, page) {
      searches++;
      return {
        query: "official query",
        order: "FECHA-SALIDA|0",
        page,
        total: 2,
        totalPages: 1,
        documentIds: ["1", "2"],
      };
    },
    async document() {
      documents++;
      throw new Error(
        "DGT HTTP 401 at do/document; stopped, no documents assumed missing.",
      );
    },
  };
  const first = await runArchive({
    store,
    client,
    maxSeconds: 5,
    maxDocuments: 1,
    clock: () => now,
  });
  assert.equal(first.status, "failed");
  assert.equal(first.fetched, 0);
  assert.equal(store.manifest.consecutiveSourceFailures, 3);
  assert.equal(
    Date.parse(store.manifest.nextSourceAttemptAt) - now,
    60 * 60 * 1000,
  );
  now += 61 * 60 * 1000;
  const restored = await ArchiveStore.open(root);
  const second = await runArchive({
    store: restored,
    client,
    maxSeconds: 5,
    maxDocuments: 1,
    clock: () => now,
  });
  assert.equal(second.status, "failed");
  assert.equal(second.fetched, 0);
  assert.equal(restored.manifest.consecutiveSourceFailures, 4);
  assert.equal(
    Date.parse(restored.manifest.nextSourceAttemptAt) - now,
    120 * 60 * 1000,
  );
  assert.equal(searches, 2);
  assert.equal(documents, 2);
  const verified = await verifyArchive(root);
  assert.equal(verified.records, 0);
  assert.equal(verified.manifest.statistics.historicalComplete, false);
  assert.equal(
    verified.manifest.windows.find((w) => w.tab === 1).sourceTotal,
    2,
  );
});
