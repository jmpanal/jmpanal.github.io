#!/usr/bin/env node
import { parseArgs } from "node:util";
import { open, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { latestDocuments } from "./archive-store.mjs";
const { values } = parseArgs({
  options: { dir: { type: "string" }, output: { type: "string" } },
});
if (!values.dir || !values.output)
  throw new Error("--dir and --output are required.");
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
const handle = await open(output + ".tmp", "w", 0o600);
let count = 0;
try {
  for await (const document of latestDocuments(values.dir)) {
    await handle.write(JSON.stringify(document) + "\n");
    count++;
  }
  await handle.sync();
} finally {
  await handle.close();
}
await rename(output + ".tmp", output);
console.log(
  JSON.stringify({
    exported: count,
    output,
    note: "Latest stored source revision per reference; no AI enrichment is implied.",
  }),
);
