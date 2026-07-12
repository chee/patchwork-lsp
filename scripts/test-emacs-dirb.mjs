import { spawn } from "node:child_process";
import * as amRepo from "@automerge/automerge-repo";
import { splice as amSplice } from "@automerge/automerge";
const sync = "wss://subduction.sync.inkandswitch.com", sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EL = "/private/tmp/claude-501/-Users-chee-soft-chee-patchwork-lsp/5b5cacf1-a219-483d-b2d2-59eb2dd3fa10/scratchpad/emacs-edit-peer2.el";
await amRepo.initSubduction();
const repo = new amRepo.Repo({ subductionWebsocketEndpoints: [sync], periodicSyncInterval: 0, batchSyncInterval: 0 });
const file = repo.create({ "@patchwork": { type: "file" }, name: "test.txt", extension: "txt", mimeType: "text/plain", content: "hello\n" });
const folder = repo.create({ "@patchwork": { type: "directory", title: "dirb" }, "test.txt": file.url });
console.log("folder:", folder.url); await sleep(4000);
const emacs = spawn("emacs", ["-Q", "--batch", "-l", EL], { env: { ...process.env, PW_FOLDER: folder.url }, cwd: process.env.HOME + "/.emacs.d" });
let done = false;
const onLine = async (l) => {
  if (l.includes("MARKER:ATTACHED")) console.log("[emacs]", l.slice(l.indexOf("MARKER")).trim());
  if (l.includes("MARKER:WAIT-B") && !done) { done = true; await sleep(1500);
    console.log("[peerA] splicing REMOTE at head (collaborative splice)...");
    file.change((d) => amSplice(d, ["content"], 0, 0, "REMOTE")); }
  if (l.includes("MARKER:FINAL")) { console.log("[emacs]", l.slice(l.indexOf("MARKER")).trim());
    console.log("Dir B (remote->editor buffer):", l.includes("REMOTEhello") ? "PASS ✓" : "FAIL ✗"); }
};
let b = ""; const feed = (d) => { b += d; let i; while ((i = b.indexOf("\n")) !== -1) { onLine(b.slice(0, i)); b = b.slice(i + 1); } };
emacs.stdout.on("data", feed); emacs.stderr.on("data", feed);
await new Promise((r) => emacs.on("exit", r)); await sleep(500);
console.log("peerA final:", JSON.stringify(String(file.doc().content)));
process.exit(0);
