#!/usr/bin/env node
// Both directions from a real Emacs. Node is peer A; Emacs edits (Dir A), then
// when Emacs signals WAIT-B, node makes a remote edit and we check Emacs's
// buffer picked it up (Dir B).
import { spawn } from "node:child_process";
import * as amRepo from "@automerge/automerge-repo";
const sync = "wss://subduction.sync.inkandswitch.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EL = "/private/tmp/claude-501/-Users-chee-soft-chee-patchwork-lsp/5b5cacf1-a219-483d-b2d2-59eb2dd3fa10/scratchpad/emacs-edit-peer2.el";

await amRepo.initSubduction();
const repo = new amRepo.Repo({ subductionWebsocketEndpoints: [sync], periodicSyncInterval: 0, batchSyncInterval: 0 });
const file = repo.create({ "@patchwork": { type: "file" }, name: "test.txt", extension: "txt", mimeType: "text/plain", content: "hello\n" });
const folder = repo.create({ "@patchwork": { type: "directory", title: "bidi" }, "test.txt": file.url });
console.log("folder:", folder.url);
await sleep(4000);

const emacs = spawn("emacs", ["-Q", "--batch", "-l", EL], { env: { ...process.env, PW_FOLDER: folder.url }, cwd: process.env.HOME + "/.emacs.d" });
let dirA = null, remoteDone = false;
const onLine = async (line) => {
  if (line.includes("MARKER:ATTACHED")) console.log("[emacs]", line.trim());
  if (line.includes("MARKER:DID-A")) { dirA = line.includes('"EMACS'); console.log("[emacs] Dir A buffer updated:", dirA); }
  if (line.includes("MARKER:WAIT-B") && !remoteDone) {
    remoteDone = true;
    await sleep(1000);
    console.log("[peerA] making remote edit (prepend REMOTE)...");
    file.change((d) => { d.content = "REMOTE" + String(d.content); });
  }
  if (line.includes("MARKER:FINAL")) {
    const gotB = line.includes("REMOTE");
    console.log("[emacs] final buffer has REMOTE:", gotB);
  }
};
let buf = "";
const feed = (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
emacs.stdout.on("data", feed); emacs.stderr.on("data", feed);
await new Promise((r) => emacs.on("exit", r));
await sleep(1000);
console.log("\n=== RESULT ===");
console.log("Dir A (editor->peer):", String(file.doc().content).startsWith("REMOTEEMACS") || String(file.doc().content).includes("EMACS") ? "PASS" : "FAIL", "| peerA:", JSON.stringify(String(file.doc().content)));
process.exit(0);
