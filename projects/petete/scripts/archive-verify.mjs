#!/usr/bin/env node
import { parseArgs } from "node:util";
import { verifyArchive, pruneArchive } from "./archive-store.mjs";
const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    shallow: { type: "boolean" },
    prune: { type: "boolean" },
  },
});
if (!values.dir) throw new Error("--dir is required.");
const result = await verifyArchive(values.dir, { deep: !values.shallow });
if (values.prune) console.log(JSON.stringify(await pruneArchive(values.dir)));
console.log(
  JSON.stringify({
    verified: true,
    documents: result.records,
    shards: result.shards,
    statistics: result.manifest.statistics,
  }),
);
