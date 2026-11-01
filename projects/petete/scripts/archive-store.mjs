import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  open,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const SCHEMA = 1;
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;
const stamp = () => new Date().toISOString();
export function isoDate(value) {
  if (
    !ISO.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error(`Invalid ISO date: ${value}`);
  return value;
}
export function monthWindows(from, to) {
  isoDate(from);
  isoDate(to);
  if (from < "1997-01-01" || from > to)
    throw new Error("Invalid archive range.");
  const windows = [];
  for (let cursor = from; cursor <= to;) {
    const d = new Date(cursor + "T00:00:00Z");
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    for (const tab of [1, 2])
      windows.push({ from: cursor, to: end < to ? end : to, tab });
    cursor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
  }
  return windows;
}
export function documentHash(document) {
  return sha256(
    JSON.stringify({
      source: document.source,
      reference: document.reference,
      date: document.date,
      title: document.title,
      text: document.text,
      source_url: document.source_url,
      tax: document.tax || "",
      binding: document.binding ? 1 : 0,
    }),
  );
}
function archivePath(root, path) {
  if (
    typeof path !== "string" ||
    !path.match(/^(corpus|indexes)\/[a-zA-Z0-9_./-]+$/) ||
    path.split("/").includes("..")
  )
    throw new Error("Unsafe archive path.");
  const result = resolve(root, path);
  if (!result.startsWith(resolve(root) + sep))
    throw new Error("Archive path escaped root.");
  return result;
}
async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + ".tmp-" + randomUUID();
  const handle = await open(temp, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}
async function immutableWrite(path, bytes) {
  try {
    const existing = await readFile(path);
    if (sha256(existing) !== sha256(bytes))
      throw new Error(`Immutable archive collision: ${path}`);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(path, bytes);
}
function initialWindow(value, campaign) {
  return {
    ...value,
    id: `${campaign}-${value.from}-${value.to}-${value.tab}`,
    campaign,
    status: "queued",
    cursor: { page: 1, nextDocument: 0, round: 0 },
    seenReferences: [],
    sourceTotal: null,
    verifiedCount: 0,
    attempts: 0,
    retryAt: null,
    error: null,
  };
}
export function createManifest(today) {
  isoDate(today);
  return {
    schema: SCHEMA,
    source: {
      name: "Dirección General de Tributos",
      url: "https://petete.tributos.hacienda.gob.es/consultas/",
      attribution: "Origen de los datos: Ministerio de Hacienda",
      reuseNotice: "https://www.hacienda.gob.es/es-ES/Paginas/avisolegal.aspx",
      publicationCutoff: null,
      publicationCutoffNote:
        "The calendar range is a query range. The official publication cutoff has not been independently read for this snapshot. No CENDOJ records are included.",
    },
    createdAt: stamp(),
    updatedAt: stamp(),
    historical: { from: "1997-01-01", to: today },
    monthlyCampaigns: [],
    windows: monthWindows("1997-01-01", today).map((w) =>
      initialWindow(w, "historical"),
    ),
    indexes: {},
    shards: {},
    statistics: {
      uniqueDocuments: 0,
      storedVersions: 0,
      historicalWindowsComplete: 0,
      historicalWindowsTotal: 0,
      historicalComplete: false,
    },
    lastRun: null,
  };
}
export class ArchiveStore {
  constructor(root, manifest, { onStage } = {}) {
    this.root = resolve(root);
    this.manifest = manifest;
    this.onStage = onStage;
    this.indexCache = new Map();
    this.pending = new Map();
    this.dirtyIndexes = new Set();
    this.referenceLocations = null;
    this.positions = new Map(
      manifest.windows.map((w) => [w.id, { ...w.cursor, status: w.status }]),
    );
  }
  static async open(
    root,
    { today = new Date().toISOString().slice(0, 10), onStage } = {},
  ) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(resolve(root, "manifest.json"), "utf8"),
      );
      if (
        manifest.schema !== SCHEMA ||
        !Array.isArray(manifest.windows) ||
        !manifest.indexes ||
        !manifest.shards
      )
        throw new Error(
          "Unsupported or corrupt archive manifest; refusing to reset.",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      manifest = createManifest(today);
    }
    return new ArchiveStore(root, manifest, { onStage });
  }
  ensureMonthly(today) {
    isoDate(today);
    const id = today.slice(0, 7);
    if (this.manifest.monthlyCampaigns.includes(id)) return false;
    const d = new Date(today + "T00:00:00Z"),
      from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1))
        .toISOString()
        .slice(0, 10);
    for (const value of monthWindows(from, today))
      this.manifest.windows.push(initialWindow(value, "monthly-" + id));
    this.manifest.monthlyCampaigns.push(id);
    return true;
  }
  nextWindow(time = Date.now()) {
    return (
      this.manifest.windows
        .filter(
          (w) =>
            w.status !== "completed" &&
            w.status !== "blocked" &&
            (!w.retryAt || Date.parse(w.retryAt) <= time),
        )
        .sort((a, b) => {
          const am = a.campaign.startsWith("monthly-"),
            bm = b.campaign.startsWith("monthly-");
          if (am !== bm) return am ? -1 : 1;
          if (am && a.campaign !== b.campaign)
            return b.campaign.localeCompare(a.campaign);
          return (
            (am
              ? b.from.localeCompare(a.from)
              : a.from.localeCompare(b.from)) || a.tab - b.tab
          );
        })[0] || null
    );
  }
  async index(key) {
    if (this.indexCache.has(key)) return this.indexCache.get(key);
    const pointer = this.manifest.indexes[key];
    let index;
    if (pointer) {
      const bytes = await readFile(archivePath(this.root, pointer.path));
      if (sha256(bytes) !== pointer.sha256)
        throw new Error(`Index checksum mismatch: ${pointer.path}`);
      index = JSON.parse(bytes);
      if (index.schema !== SCHEMA || !index.records)
        throw new Error("Invalid immutable reference index.");
    } else {
      const [month, tab] = key.split("/");
      index = { schema: SCHEMA, month, tab: Number(tab), records: {} };
    }
    this.indexCache.set(key, index);
    return index;
  }
  async ensureLocations() {
    if (this.referenceLocations) return;
    this.referenceLocations = new Map();
    for (const key of Object.keys(this.manifest.indexes)) {
      const index = await this.index(key);
      for (const ref of Object.keys(index.records)) {
        if (this.referenceLocations.has(ref))
          throw new Error(
            `Duplicate ruling reference in different monthly indexes: ${ref}`,
          );
        this.referenceLocations.set(ref, key);
      }
    }
  }
  async record(window, document) {
    if (
      document.source !== "dgt" ||
      typeof document.reference !== "string" ||
      !document.reference.trim() ||
      typeof document.text !== "string" ||
      document.text.length < 20 ||
      document.date < window.from ||
      document.date > window.to ||
      Boolean(document.binding) !== (window.tab === 2)
    )
      throw new Error("Invalid or out-of-window DGT record.");
    const key = `${document.date.slice(0, 7)}/${window.tab}`,
      index = await this.index(key),
      hash = documentHash(document);
    await this.ensureLocations();
    const oldKey = this.referenceLocations.get(document.reference);
    if (oldKey && oldKey !== key) {
      const oldIndex = await this.index(oldKey);
      delete oldIndex.records[document.reference];
      this.pending.get(oldKey)?.delete(document.reference);
      this.dirtyIndexes.add(oldKey);
    }
    this.referenceLocations.set(document.reference, key);
    const baseline = index.records[document.reference]?.sha256,
      existing = this.pending.get(key)?.get(document.reference);
    if (hash === baseline) {
      this.pending.get(key)?.delete(document.reference);
    } else if (existing?.hash !== hash) {
      if (!this.pending.has(key)) this.pending.set(key, new Map());
      this.pending.get(key).set(document.reference, { document, hash });
    }
    if (!window.seenReferences.includes(document.reference))
      window.seenReferences.push(document.reference);
    return hash;
  }
  async persist() {
    for (const window of this.manifest.windows) {
      const previous = this.positions.get(window.id);
      if (previous) {
        const old = [previous.round || 0, previous.page, previous.nextDocument],
          current = [
            window.cursor.round || 0,
            window.cursor.page,
            window.cursor.nextDocument,
          ];
        let comparison = 0;
        for (let i = 0; i < 3; i++) {
          if (current[i] !== old[i]) {
            comparison = current[i] > old[i] ? 1 : -1;
            break;
          }
        }
        if (
          comparison < 0 ||
          (previous.status === "completed" && window.status !== "completed")
        )
          throw new Error(`Archive cursor would move backward: ${window.id}`);
      }
    }
    for (const [key, pending] of this.pending) {
      if (!pending.size) continue;
      const index = await this.index(key),
        entries = [...pending.values()];
      let offset = 0;
      while (offset < entries.length) {
        let group = [],
          rawLength = 0;
        while (offset < entries.length && group.length < 25) {
          const item = entries[offset],
            line = JSON.stringify(item.document) + "\n",
            length = Buffer.byteLength(line);
          if (length > 8 * 1024 * 1024)
            throw new Error("A source document exceeds the 8 MiB shard limit.");
          if (group.length && rawLength + length > 8 * 1024 * 1024) break;
          group.push({ ...item, line });
          rawLength += length;
          offset++;
        }
        const raw = Buffer.from(group.map((x) => x.line).join("")),
          compressed = gzipSync(raw, { level: 6 }),
          hash = sha256(compressed),
          path = `corpus/${key}/${hash}.jsonl.gz`;
        await immutableWrite(archivePath(this.root, path), compressed);
        await this.onStage?.("after-shard");
        this.manifest.shards[path] = {
          sha256: hash,
          records: group.length,
          rawBytes: raw.length,
          gzipBytes: compressed.length,
          createdAt: stamp(),
        };
        group.forEach((item, position) => {
          index.records[item.document.reference] = {
            shard: path,
            position,
            sha256: item.hash,
            date: item.document.date,
          };
        });
      }
      this.dirtyIndexes.add(key);
      pending.clear();
    }
    for (const key of this.dirtyIndexes) {
      const index = await this.index(key),
        bytes = Buffer.from(JSON.stringify(index)),
        hash = sha256(bytes),
        path = `indexes/${key}/${hash}.json`;
      await immutableWrite(archivePath(this.root, path), bytes);
      await this.onStage?.("after-index");
      this.manifest.indexes[key] = {
        path,
        sha256: hash,
        records: Object.keys(index.records).length,
        month: index.month,
        tab: index.tab,
      };
    }
    this.dirtyIndexes.clear();
    const historical = this.manifest.windows.filter(
      (w) => w.campaign === "historical",
    );
    this.manifest.statistics = {
      uniqueDocuments: Object.values(this.manifest.indexes).reduce(
        (n, x) => n + x.records,
        0,
      ),
      storedVersions: Object.values(this.manifest.shards).reduce(
        (n, x) => n + x.records,
        0,
      ),
      historicalWindowsComplete: historical.filter(
        (w) => w.status === "completed",
      ).length,
      historicalWindowsTotal: historical.length,
      historicalComplete:
        historical.length > 0 &&
        historical.every((w) => w.status === "completed"),
    };
    this.manifest.updatedAt = stamp();
    await this.onStage?.("before-manifest");
    await atomicWrite(
      resolve(this.root, "manifest.json"),
      Buffer.from(JSON.stringify(this.manifest, null, 2) + "\n"),
    );
    this.positions = new Map(
      this.manifest.windows.map((w) => [
        w.id,
        { ...w.cursor, status: w.status },
      ]),
    );
    await this.onStage?.("after-manifest");
  }
  fail(window, error, time = Date.now()) {
    window.attempts++;
    window.error = String(error).slice(0, 2000);
    window.status = window.attempts >= 6 ? "blocked" : "retry";
    window.retryAt = new Date(
      time + Math.min(86400000, 15 * 60000 * 2 ** (window.attempts - 1)),
    ).toISOString();
  }
  reconcile(window, total) {
    if (!Number.isSafeInteger(total) || total < 0)
      throw new Error("Invalid source total.");
    window.sourceTotal = total;
    if (window.seenReferences.length !== total) {
      if ((window.cursor.round || 0) >= 2)
        throw new Error(
          `Reconciliation failed: ${window.seenReferences.length} unique references, official source count ${total}.`,
        );
      window.cursor = {
        page: 1,
        nextDocument: 0,
        round: (window.cursor.round || 0) + 1,
      };
      window.status = "queued";
      window.error = "Source pagination changed; reconciliation pass required.";
      return false;
    }
    window.status = "completed";
    window.verifiedCount = window.seenReferences.length;
    window.seenReferences = [];
    window.completedAt = stamp();
    window.attempts = 0;
    window.retryAt = null;
    window.error = null;
    return true;
  }
}
export async function verifyArchive(root, { deep = true } = {}) {
  const manifest = JSON.parse(
    await readFile(resolve(root, "manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== SCHEMA ||
    !manifest.indexes ||
    !manifest.shards ||
    !Array.isArray(manifest.windows)
  )
    throw new Error("Invalid archive manifest.");
  const indexes = [];
  let records = 0;
  const references = new Set();
  for (const [key, pointer] of Object.entries(manifest.indexes)) {
    if (!HASH.test(pointer.sha256)) throw new Error("Invalid index checksum.");
    const bytes = await readFile(archivePath(root, pointer.path));
    if (sha256(bytes) !== pointer.sha256)
      throw new Error(`Index checksum mismatch: ${pointer.path}`);
    const index = JSON.parse(bytes);
    if (
      index.schema !== SCHEMA ||
      `${index.month}/${index.tab}` !== key ||
      !index.records ||
      Object.keys(index.records).length !== pointer.records
    )
      throw new Error(`Index metadata mismatch: ${pointer.path}`);
    for (const [reference, p] of Object.entries(index.records)) {
      if (references.has(reference))
        throw new Error(
          `Duplicate reference across monthly indexes: ${reference}`,
        );
      references.add(reference);
      if (
        !manifest.shards[p.shard] ||
        !HASH.test(p.sha256) ||
        !Number.isInteger(p.position) ||
        p.position < 0 ||
        p.position >= manifest.shards[p.shard].records ||
        !reference
      )
        throw new Error(`Invalid document pointer: ${reference}`);
    }
    records += pointer.records;
    indexes.push(index);
  }
  const pointersByShard = new Map();
  for (const index of indexes)
    for (const [reference, pointer] of Object.entries(index.records)) {
      if (!pointersByShard.has(pointer.shard))
        pointersByShard.set(pointer.shard, []);
      pointersByShard.get(pointer.shard).push({ index, reference, pointer });
    }
  for (const [path, meta] of Object.entries(manifest.shards)) {
    if (
      !HASH.test(meta.sha256) ||
      meta.records < 1 ||
      meta.rawBytes > 8 * 1024 * 1024 ||
      meta.gzipBytes > 9 * 1024 * 1024
    )
      throw new Error(`Invalid shard metadata: ${path}`);
    if (deep) {
      const bytes = await readFile(archivePath(root, path));
      if (bytes.length !== meta.gzipBytes || sha256(bytes) !== meta.sha256)
        throw new Error(`Shard checksum mismatch: ${path}`);
      const raw = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
      const lines = raw
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (raw.length !== meta.rawBytes || lines.length !== meta.records)
        throw new Error(`Shard count mismatch: ${path}`);
      for (const { index, reference, pointer } of pointersByShard.get(path) ||
        []) {
        const doc = lines[pointer.position];
        if (
          !doc ||
          doc.source !== "dgt" ||
          doc.reference !== reference ||
          doc.date !== pointer.date ||
          documentHash(doc) !== pointer.sha256 ||
          doc.date.slice(0, 7) !== index.month ||
          Boolean(doc.binding) !== (index.tab === 2)
        )
          throw new Error(`Document integrity failure: ${reference}`);
      }
    } else if ((await stat(archivePath(root, path))).size !== meta.gzipBytes)
      throw new Error(`Shard size mismatch: ${path}`);
  }
  const historical = manifest.windows.filter(
      (w) => w.campaign === "historical",
    ),
    expected = monthWindows(manifest.historical?.from, manifest.historical?.to)
      .map((w) => `${w.from}/${w.to}/${w.tab}`)
      .sort(),
    actual = historical.map((w) => `${w.from}/${w.to}/${w.tab}`).sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, i) => value !== actual[i]) ||
    new Set(manifest.windows.map((w) => w.id)).size !== manifest.windows.length
  )
    throw new Error(
      "Historical archive windows are missing, duplicated or discontinuous.",
    );
  for (const window of manifest.windows) {
    if (
      ![1, 2].includes(window.tab) ||
      !Number.isInteger(window.cursor?.page) ||
      window.cursor.page < 1 ||
      !Number.isInteger(window.cursor.nextDocument) ||
      window.cursor.nextDocument < 0
    )
      throw new Error("Invalid source cursor.");
    if (
      window.status === "completed" &&
      (window.verifiedCount !== window.sourceTotal ||
        window.sourceTotal === null)
    )
      throw new Error(`Unreconciled completed window: ${window.id}`);
  }
  if (
    Object.values(manifest.shards).reduce((n, x) => n + x.records, 0) !==
    manifest.statistics.storedVersions
  )
    throw new Error("Manifest stored-version count mismatch.");
  if (records !== manifest.statistics.uniqueDocuments)
    throw new Error("Manifest unique-document count mismatch.");
  const completed = historical.filter((w) => w.status === "completed").length;
  if (
    manifest.statistics.historicalWindowsComplete !== completed ||
    manifest.statistics.historicalWindowsTotal !== historical.length ||
    manifest.statistics.historicalComplete !==
      (historical.length > 0 && completed === historical.length)
  )
    throw new Error("Manifest historical coverage mismatch.");
  return {
    manifest,
    indexes,
    records,
    shards: Object.keys(manifest.shards).length,
  };
}
export async function pruneArchive(root) {
  const { manifest } = await verifyArchive(root, { deep: false }),
    keep = new Set([
      ...Object.keys(manifest.shards),
      ...Object.values(manifest.indexes).map((x) => x.path),
    ]);
  let removed = 0;
  for (const folder of ["corpus", "indexes"]) {
    const path = resolve(root, folder);
    let entries;
    try {
      entries = await readdir(path, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = resolve(entry.parentPath, entry.name),
        rel = relative(resolve(root), full).split(sep).join("/");
      if (!keep.has(rel)) {
        await rm(full);
        removed++;
      }
    }
  }
  return { removed };
}
export async function* latestDocuments(root) {
  const { manifest, indexes } = await verifyArchive(root, { deep: false });
  for (const index of indexes.sort(
    (a, b) => a.month.localeCompare(b.month) || a.tab - b.tab,
  )) {
    const byShard = new Map();
    for (const [ref, pointer] of Object.entries(index.records)) {
      if (!byShard.has(pointer.shard)) byShard.set(pointer.shard, []);
      byShard.get(pointer.shard).push([ref, pointer]);
    }
    for (const [path, pointers] of byShard) {
      const bytes = await readFile(archivePath(root, path));
      if (sha256(bytes) !== manifest.shards[path].sha256)
        throw new Error("Shard checksum mismatch during export.");
      const docs = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 })
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const [ref, p] of pointers) {
        const doc = docs[p.position];
        if (!doc || doc.reference !== ref || documentHash(doc) !== p.sha256)
          throw new Error("Document checksum mismatch during export.");
        yield doc;
      }
    }
  }
}
