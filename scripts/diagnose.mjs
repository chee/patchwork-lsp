#!/usr/bin/env node
// Reproduce exactly what the Emacs client asks the server to do, but print the
// server's own logs so we can see whether the automerge folder actually syncs.
//
//   node scripts/diagnose.mjs automerge:<yourFolderId> [wss://sync-server]
//
// Watch for:
//   * "Loaded N files from FolderDoc"  -> sync works, materialization done
//   * files appearing under the cache dir (printed each second)
//   * if it just sits at "Folder URL: ..." forever -> repo.find() never resolved
//     i.e. the doc is not syncing from subduction (network / wrong url / not on
//     this sync server). That is the same thing that makes Emacs hang.

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const folderUrl = process.argv[2];
const syncServer = process.argv[3] || "wss://subduction.sync.inkandswitch.com";
if (!folderUrl) {
  console.error("usage: node scripts/diagnose.mjs automerge:<folderId> [syncServerUrl]");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "dist", "server.cjs");

const docId = folderUrl.startsWith("automerge:") ? folderUrl.slice("automerge:".length) : folderUrl;
const cacheDir =
  os.platform() === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "patchwork-lsp", "docs", docId)
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "patchwork-lsp", "docs", docId);

console.log("server   :", server);
console.log("folderUrl:", folderUrl);
console.log("sync     :", syncServer);
console.log("cacheDir :", cacheDir);
console.log("----------------------------------------------------------------");

const child = spawn("node", [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
const send = (o) => {
  const b = JSON.stringify(o);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
};

let buf = Buffer.alloc(0);
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const m = buf.slice(0, sep).toString().match(/Content-Length: (\d+)/i);
    if (!m) return;
    const start = sep + 4, len = parseInt(m[1], 10);
    if (buf.length < start + len) return;
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
    if (msg.method === "window/logMessage") console.log("[server]", msg.params.message);
    else if (msg.method === "window/showMessage") console.log("[server:show]", msg.params.message);
    else if (msg.method === "automerge/status") console.log("[status]", JSON.stringify(msg.params));
    else if (msg.id === 1) {
      console.log("[initialize] responded OK");
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));
child.on("exit", (c) => console.log("server exited", c));

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    processId: process.pid,
    rootUri: "file://" + cacheDir,
    capabilities: {},
    initializationOptions: { folderUrl, syncServerUrl: syncServer, debug: true },
  },
});

// poll the cache dir so we can see materialization happen (or not)
const countFiles = (dir) => {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
    }
  } catch {}
  return n;
};
const timer = setInterval(() => console.log(`... cache dir has ${countFiles(cacheDir)} file(s)`), 1000);
setTimeout(() => { clearInterval(timer); console.log("---- done (30s) ----"); child.kill(); process.exit(0); }, 30000);
