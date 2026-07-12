#!/usr/bin/env node
// Full live-edit round-trip test against a scratch folder we create.
// Peer A (this process) creates a folder+file, the LSP server (its own repo,
// synced via subduction) opens+edits it, and we check the change propagates
// BOTH ways.  Never touches any real folder.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as amRepo from "@automerge/automerge-repo";

const sync = "wss://subduction.sync.inkandswitch.com";
const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "dist", "server.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await amRepo.initSubduction();
const repo = new amRepo.Repo({ subductionWebsocketEndpoints: [sync], periodicSyncInterval: 0, batchSyncInterval: 0 });

// --- Peer A creates a scratch folder + one collaborative text file ---
const file = repo.create({
  "@patchwork": { type: "file" },
  name: "test.txt",
  extension: "txt",
  mimeType: "text/plain",
  content: "hello\n",
});
const folder = repo.create({
  "@patchwork": { type: "directory", title: "livetest" },
  "test.txt": file.url,
});
console.log("created folder:", folder.url, "file:", file.url);
console.log("waiting 4s for subduction to persist...");
await sleep(4000);

const docId = folder.url.slice("automerge:".length);
const cacheDir = os.platform() === "darwin"
  ? path.join(os.homedir(), "Library", "Caches", "patchwork-lsp", "docs", docId)
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "patchwork-lsp", "docs", docId);
const fileUri = "file://" + path.join(cacheDir, "test.txt");

// --- spawn the LSP server ---
const child = spawn("node", [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
let seq = 100;
const send = (o) => { const b = JSON.stringify(o); child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); };
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const request = (method, params) => send({ jsonrpc: "2.0", id: seq++, method, params });

let applyEditCount = 0;
let lastApplyEdit = null;
let buf = Buffer.alloc(0);
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const s = buf.indexOf("\r\n\r\n"); if (s === -1) return;
    const m = buf.slice(0, s).toString().match(/Content-Length: (\d+)/i); if (!m) return;
    const start = s + 4, len = +m[1]; if (buf.length < start + len) return;
    const msg = JSON.parse(buf.slice(start, start + len).toString()); buf = buf.slice(start + len);
    if (msg.method === "window/logMessage") { /* console.log("[srv]", msg.params.message); */ }
    else if (msg.method === "workspace/applyEdit") {
      applyEditCount++; lastApplyEdit = msg.params;
      console.log("[server->client] workspace/applyEdit:", JSON.stringify(msg.params.edit?.changes));
      send({ jsonrpc: "2.0", id: msg.id, result: { applied: true } }); // must respond
    } else if (msg.id === 1) {
      console.log("[initialize] ok");
      notify("initialized", {});
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));

// watch Peer A's file doc for changes coming FROM the server
let peerAContent = () => String(file.doc().content);
file.on("change", () => console.log("   [peerA sees] content =", JSON.stringify(peerAContent())));

// initialize
request("initialize", {
  processId: process.pid, rootUri: "file://" + cacheDir, capabilities: {},
  initializationOptions: { folderUrl: folder.url, syncServerUrl: sync, debug: true },
});

// wait for materialization
for (let i = 0; i < 30 && !fs.existsSync(path.join(cacheDir, "test.txt")); i++) await sleep(500);
console.log("materialized test.txt:", fs.existsSync(path.join(cacheDir, "test.txt")));

// --- DIRECTION A: editor -> automerge ---
console.log("\n== Direction A: didChange in editor should update the automerge doc ==");
notify("textDocument/didOpen", { textDocument: { uri: fileUri, languageId: "plaintext", version: 1, text: "hello\n" } });
await sleep(500);
notify("textDocument/didChange", {
  textDocument: { uri: fileUri, version: 2 },
  contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "X" }],
});
await sleep(3000);
console.log("Direction A result: peerA content =", JSON.stringify(peerAContent()), peerAContent() === "Xhello\n" ? "✓ PASS" : "✗ FAIL");

// --- DIRECTION B: automerge -> editor ---
console.log("\n== Direction B: remote change should push workspace/applyEdit to editor ==");
const before = applyEditCount;
file.change((d) => { const s = String(d.content); d.content = "Y" + s; });
await sleep(3000);
console.log("Direction B result: applyEdit count delta =", applyEditCount - before, (applyEditCount - before) > 0 ? "✓ PASS" : "✗ FAIL");

request("shutdown", null);
await sleep(300);
child.kill();
process.exit(0);
