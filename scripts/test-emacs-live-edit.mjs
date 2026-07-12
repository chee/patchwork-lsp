#!/usr/bin/env node
// Orchestrate: node creates a scratch folder (peer A) and keeps it live, spawns
// a real Emacs (batch) that opens the file via lsp-mode + patchwork-lsp and
// edits it. We then check whether Emacs's edit propagated to peer A.
import { spawn } from "node:child_process";
import * as amRepo from "@automerge/automerge-repo";

const sync = "wss://subduction.sync.inkandswitch.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EL = process.argv[2] || "/private/tmp/claude-501/-Users-chee-soft-chee-patchwork-lsp/5b5cacf1-a219-483d-b2d2-59eb2dd3fa10/scratchpad/emacs-edit-peer.el";

await amRepo.initSubduction();
const repo = new amRepo.Repo({ subductionWebsocketEndpoints: [sync], periodicSyncInterval: 0, batchSyncInterval: 0 });

const file = repo.create({
  "@patchwork": { type: "file" }, name: "test.txt", extension: "txt",
  mimeType: "text/plain", content: "hello\n",
});
const folder = repo.create({
  "@patchwork": { type: "directory", title: "emacs-live" }, "test.txt": file.url,
});
console.log("folder:", folder.url);
file.on("change", () => console.log("   [peerA] content ->", JSON.stringify(String(file.doc().content))));
console.log("waiting 4s for persist...");
await sleep(4000);

console.log("launching emacs (batch)...\n");
const emacs = spawn("emacs", ["-Q", "--batch", "-l", EL], {
  env: { ...process.env, PW_FOLDER: folder.url },
  cwd: process.env.HOME + "/.emacs.d",
});
emacs.stdout.on("data", (d) => process.stdout.write("[emacs] " + d));
emacs.stderr.on("data", (d) => process.stdout.write("[emacs] " + d));
await new Promise((r) => emacs.on("exit", r));

await sleep(2000);
const final = String(file.doc().content);
console.log("\n================ RESULT ================");
console.log("peerA final content:", JSON.stringify(final));
console.log(final.startsWith("EMACS")
  ? "✓ PASS — Emacs edit propagated to the other peer (live editing works)"
  : "✗ FAIL — Emacs edit did NOT propagate");
process.exit(0);
