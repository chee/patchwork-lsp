#!/usr/bin/env node
// Connect to subduction, find a directory doc, dump its entries + one file doc.
//   node scripts/inspect-doc.mjs automerge:<id> [wss://sync]
import * as amRepo from "@automerge/automerge-repo";

const url = process.argv[2];
const sync = process.argv[3]?.startsWith("wss") ? process.argv[3] : "wss://subduction.sync.inkandswitch.com";
if (!url) { console.error("usage: node scripts/inspect-doc.mjs automerge:<id> [wss://sync]"); process.exit(2); }

await amRepo.initSubduction();
const repo = new amRepo.Repo({
  subductionWebsocketEndpoints: [sync],
  periodicSyncInterval: 0,
  batchSyncInterval: 0,
});

console.log("finding", url, "...");
const handle = await repo.find(url);
const doc = handle.doc();
console.log("=== @patchwork:", JSON.stringify(doc["@patchwork"]));
console.log("=== entries (key -> value):");
const META = new Set(["@patchwork", "lastSyncAt", "with", "name", "title"]);
const fileKeys = [];
for (const [k, v] of Object.entries(doc)) {
  if (META.has(k)) continue;
  const kind = typeof v === "string" ? (v.includes("@") ? "VERSIONED-url" : "url") : typeof v;
  console.log(`  ${JSON.stringify(k)}  [${kind}, len ${typeof v === "string" ? v.length : "-"}] = ${JSON.stringify(v)}`);
  if (typeof v === "string" && v.startsWith("automerge:") && !k.startsWith(".")) fileKeys.push([k, v]);
}

// follow up to 3 file docs to learn the file-doc shape
console.log("\n=== following up to 3 file docs:");
for (const [k, v] of fileKeys.slice(0, 3)) {
  console.log(`\n-- ${k}  (${v})`);
  try {
    const ch = await repo.find(v);
    const cd = ch.doc();
    console.log("   keys:", Object.keys(cd));
    console.log("   @patchwork:", JSON.stringify(cd["@patchwork"]));
    for (const [ck, cv] of Object.entries(cd)) {
      const desc = cv instanceof Uint8Array ? `Uint8Array(${cv.length})`
        : typeof cv === "string" ? `string(${cv.length})${cv.length < 50 ? " = " + JSON.stringify(cv) : ""}`
        : JSON.stringify(cv);
      console.log(`     ${JSON.stringify(ck)}: ${desc}`);
    }
  } catch (e) { console.log("   find failed:", e.message); }
}
process.exit(0);
