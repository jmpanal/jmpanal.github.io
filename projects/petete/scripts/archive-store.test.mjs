import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ArchiveStore,
  verifyArchive,
  latestDocuments,
  pruneArchive,
  documentHash,
} from "./archive-store.mjs";

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "petete-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ArchiveStore.open(root, {
    today: "1997-01-31",
    ...options,
  });
  await store.persist();
  return { root, store };
}
const record = (reference = "0001-97", overrides = {}) => ({
  source: "dgt",
  reference,
  date: "1997-01-03",
  title: "Consulta tributaria oficial",
  text: "Contenido completo de la consulta sobre un criterio tributario verificable.",
  source_url: `https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=${reference}`,
  tax: "IVA",
  binding: 0,
  provenance: { retrievedAt: "2026-11-01T00:00:00Z" },
  ...overrides,
});
const documents = async (root) => {
  const result = [];
  for await (const row of latestDocuments(root)) result.push(row);
  return result;
};

for (const stage of ["after-shard", "after-index", "before-manifest"]) {
  test(`crash ${stage} preserves the previous committed cursor and corpus`, async (t) => {
    const { root, store } = await setup(t);
    let window = store.nextWindow();
    await store.record(window, record());
    window.cursor.nextDocument = 1;
    await store.persist();
    const original = await readFile(join(root, "manifest.json"), "utf8");
    const crashing = await ArchiveStore.open(root, {
      onStage: (value) => {
        if (value === stage) throw new Error("injected power loss");
      },
    });
    window = crashing.nextWindow();
    await crashing.record(window, record("0002-97"));
    window.cursor.nextDocument = 2;
    await assert.rejects(crashing.persist(), /injected power loss/);
    assert.equal(await readFile(join(root, "manifest.json"), "utf8"), original);
    const verified = await verifyArchive(root);
    assert.equal(verified.records, 1);
    assert.deepEqual(
      (await documents(root)).map((x) => x.reference),
      ["0001-97"],
    );
    const restored = await ArchiveStore.open(root);
    assert.equal(restored.nextWindow().cursor.nextDocument, 1);
    const pruned = await pruneArchive(root);
    assert.ok(pruned.removed >= 1);
    await verifyArchive(root);
  });
}

test("a successful checkpoint publishes cursor and exact document data together", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  await store.record(window, record());
  window.cursor.nextDocument = 1;
  await store.persist();
  const restored = await ArchiveStore.open(root);
  assert.equal(restored.nextWindow().cursor.nextDocument, 1);
  assert.equal(restored.nextWindow().seenReferences.length, 1);
  const verified = await verifyArchive(root);
  assert.equal(verified.records, 1);
  assert.equal(verified.manifest.statistics.historicalComplete, false);
  assert.equal((await documents(root))[0].text, record().text);
});

test("a corrupted compressed shard is rejected before export or publication", async (t) => {
  const { root, store } = await setup(t);
  await store.record(store.nextWindow(), record());
  await store.persist();
  const path = Object.keys(store.manifest.shards)[0];
  await writeFile(resolve(root, path), "broken source shard");
  await assert.rejects(verifyArchive(root), /checksum mismatch/);
  await assert.rejects(documents(root), /checksum mismatch|size mismatch/);
});

test("duplicate source records and changed retrieval timestamps do not duplicate corpus versions", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  await store.record(window, record());
  await store.persist();
  const first = structuredClone(store.manifest.statistics);
  await store.record(
    window,
    record("0001-97", { provenance: { retrievedAt: "2026-12-01T00:00:00Z" } }),
  );
  await store.persist();
  assert.equal(window.seenReferences.length, 1);
  assert.deepEqual(store.manifest.statistics, first);
  assert.equal((await verifyArchive(root)).shards, 1);
});

test("a revised ruling retains source history and exports only its latest version", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  await store.record(window, record());
  await store.persist();
  const revised = record("0001-97", {
    text: "Texto oficial corregido de la consulta con un contenido material diferente.",
  });
  await store.record(window, revised);
  await store.persist();
  const docs = await documents(root);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].text, revised.text);
  assert.equal(store.manifest.statistics.uniqueDocuments, 1);
  assert.equal(store.manifest.statistics.storedVersions, 2);
  await verifyArchive(root);
});

test("the last observed source revision wins even when it reverts before flushing", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  const original = record();
  await store.record(window, original);
  await store.persist();
  await store.record(
    window,
    record("0001-97", {
      text: "Primera revisión oficial diferente todavía pendiente de persistir.",
    }),
  );
  await store.record(window, original);
  await store.persist();
  assert.equal(
    documentHash((await documents(root))[0]),
    documentHash(original),
  );
});

test("source-count mismatches never mark the archive window complete", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  await store.record(window, record());
  window.cursor = { page: 7, nextDocument: 3, round: 0 };
  assert.equal(store.reconcile(window, 2), false);
  assert.equal(window.status, "queued");
  assert.deepEqual(window.cursor, { page: 1, nextDocument: 0, round: 1 });
  assert.equal(store.reconcile(window, 2), false);
  assert.throws(() => store.reconcile(window, 2), /Reconciliation failed/);
  await store.persist();
  assert.equal(
    (await verifyArchive(root)).manifest.statistics.historicalComplete,
    false,
  );
});

test("full historical completion requires every general and binding window to reconcile", async (t) => {
  const { root, store } = await setup(t);
  const general = store.manifest.windows.find((w) => w.tab === 1),
    binding = store.manifest.windows.find((w) => w.tab === 2);
  await store.record(general, record());
  assert.equal(store.reconcile(general, 1), true);
  await store.persist();
  assert.equal(store.manifest.statistics.historicalComplete, false);
  assert.equal(store.reconcile(binding, 0), true);
  await store.persist();
  const verified = await verifyArchive(root);
  assert.equal(verified.manifest.statistics.historicalComplete, true);
  assert.equal(verified.manifest.statistics.historicalWindowsComplete, 2);
});

test("verification rejects a fabricated complete range that omits an uncollected window", async (t) => {
  const { root, store } = await setup(t);
  const first = store.manifest.windows[0];
  store.reconcile(first, 0);
  await store.persist();
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  );
  manifest.windows = manifest.windows.filter((w) => w.id === first.id);
  manifest.statistics.historicalWindowsComplete = 1;
  manifest.statistics.historicalWindowsTotal = 1;
  manifest.statistics.historicalComplete = true;
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyArchive(root), /historical|window|coverage/i);
});

test("monthly refresh has priority over an unfinished 1997 archive", async (t) => {
  const { store } = await setup(t);
  assert.equal(store.nextWindow().campaign, "historical");
  assert.equal(store.ensureMonthly("2026-11-01"), true);
  assert.equal(store.ensureMonthly("2026-11-20"), false);
  const next = store.nextWindow();
  assert.equal(next.campaign, "monthly-2026-11");
  assert.equal(next.from, "2026-11-01");
  assert.equal(store.manifest.monthlyCampaigns.length, 1);
});

test("source failures back off and remain visibly incomplete after repeated failure", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  const time = Date.parse("2026-11-01T00:00:00Z");
  store.fail(window, new Error("HTTP 401, no missing documents assumed"), time);
  assert.equal(window.status, "retry");
  assert.ok(Date.parse(window.retryAt) > time);
  assert.notEqual(store.nextWindow(time)?.id, window.id);
  for (let i = 0; i < 5; i++)
    store.fail(window, new Error("source unavailable"), time);
  assert.equal(window.status, "blocked");
  await store.persist();
  assert.equal(
    (await verifyArchive(root)).manifest.statistics.historicalComplete,
    false,
  );
});

test("archive excludes CENDOJ data and documents outside the queried source window", async (t) => {
  const { store } = await setup(t);
  const window = store.nextWindow();
  await assert.rejects(
    store.record(window, record("ROJ:test", { source: "cendoj" })),
    /Invalid/,
  );
  await assert.rejects(
    store.record(window, record("0001-97", { date: "1997-02-01" })),
    /out-of-window/,
  );
  await assert.rejects(
    store.record(window, record("V0001-97", { binding: 1 })),
    /Invalid/,
  );
});

test("a crash after atomic manifest replacement leaves the entire new snapshot valid", async (t) => {
  const { root, store } = await setup(t);
  let window = store.nextWindow();
  await store.record(window, record());
  window.cursor.nextDocument = 1;
  await store.persist();
  const crashing = await ArchiveStore.open(root, {
    onStage: (stage) => {
      if (stage === "after-manifest")
        throw new Error("crash after publication");
    },
  });
  window = crashing.nextWindow();
  await crashing.record(window, record("0002-97"));
  window.cursor.nextDocument = 2;
  await assert.rejects(crashing.persist(), /crash after publication/);
  const restored = await ArchiveStore.open(root);
  assert.equal(restored.nextWindow().cursor.nextDocument, 2);
  assert.equal((await verifyArchive(root)).records, 2);
  assert.equal((await documents(root)).length, 2);
});

test("a persisted cursor cannot move backward within the same reconciliation pass", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  await store.record(window, record());
  window.cursor.nextDocument = 1;
  await store.persist();
  const original = await readFile(join(root, "manifest.json"), "utf8");
  window.cursor.nextDocument = 0;
  await assert.rejects(store.persist(), /move backward/);
  assert.equal(await readFile(join(root, "manifest.json"), "utf8"), original);
  await verifyArchive(root);
});

test("a completed source window cannot silently reopen in a later checkpoint", async (t) => {
  const { root, store } = await setup(t);
  const window = store.nextWindow();
  store.reconcile(window, 0);
  await store.persist();
  const original = await readFile(join(root, "manifest.json"), "utf8");
  window.status = "queued";
  await assert.rejects(store.persist(), /move backward/);
  assert.equal(await readFile(join(root, "manifest.json"), "utf8"), original);
});

test("an official date correction moves the latest ruling between monthly indexes without duplicating it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "petete-archive-date-correction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ArchiveStore.open(root, { today: "1997-02-28" });
  const january = store.manifest.windows.find(
    (w) => w.from === "1997-01-01" && w.tab === 1,
  );
  await store.record(january, record());
  january.cursor.nextDocument = 1;
  await store.persist();
  const originalShard = Object.keys(store.manifest.shards)[0],
    originalBytes = await readFile(resolve(root, originalShard));
  const restored = await ArchiveStore.open(root);
  const february = restored.manifest.windows.find(
    (w) => w.from === "1997-02-01" && w.tab === 1,
  );
  const corrected = record("0001-97", {
    date: "1997-02-03",
    text: "Texto oficial completo con su fecha de salida corregida al mes de febrero.",
  });
  await restored.record(february, corrected);
  february.cursor.nextDocument = 1;
  await restored.persist();
  const verified = await verifyArchive(root);
  assert.equal(verified.manifest.statistics.uniqueDocuments, 1);
  assert.equal(verified.manifest.statistics.storedVersions, 2);
  assert.equal(verified.manifest.indexes["1997-01/1"].records, 0);
  assert.equal(verified.manifest.indexes["1997-02/1"].records, 1);
  assert.deepEqual(await readFile(resolve(root, originalShard)), originalBytes);
  const exported = await documents(root);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].reference, "0001-97");
  assert.equal(exported[0].date, "1997-02-03");
  assert.equal(exported[0].text, corrected.text);
});

test('official canceled-number notices reconcile as source records while remaining distinct from rulings', async (t) => {
  const {root,store}=await setup(t);
  const window=store.nextWindow();
  const notice=record('0002-97',{title:'Número de consulta anulado',text:'Número de consulta\n0002-97 Número de consulta anulado\n\nFecha salida\n03/01/1997',provenance:{documentKind:'cancellation_notice',officialNotice:'0002-97 Número de consulta anulado',fullRulingText:false,rulingAvailable:false}});
  await store.record(window,record());await store.record(window,notice);window.cursor.nextDocument=2;
  assert.equal(store.reconcile(window,2),true);await store.persist();
  const verified=await verifyArchive(root);
  assert.equal(verified.manifest.statistics.uniqueDocuments,2);
  assert.equal(verified.manifest.statistics.rulings,1);
  assert.equal(verified.manifest.statistics.cancellationNotices,1);
  assert.equal((await documents(root)).find(doc=>doc.reference==='0002-97').provenance.documentKind,'cancellation_notice');
});
