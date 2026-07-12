#!/usr/bin/env node

import * as os from "os";
import * as path from "path";
import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { AutomergeBridge } from "./automerge-bridge.js";
import { FileMapper } from "./file-mapper.js";
import { StatusNotifier } from "./status-notifier.js";
import { DebugLogger } from "./debug-logger.js";
import { setupHandlers, getInitializeResult, registerDocument, PendingDocuments, type InitOptions } from "./lsp-handler.js";
import { ImportResolver } from "./import-resolver.js";
import type { FolderDoc } from "./types.js";

const connection = createConnection(ProposedFeatures.all);
const statusNotifier = new StatusNotifier(connection);
const pendingDocs = new PendingDocuments();

let bridge: AutomergeBridge | undefined;
let fileMapper: FileMapper | undefined;
let importResolver: ImportResolver | undefined;
let debugLogger: DebugLogger;
let workspaceRoot: string | undefined;
let rootDocId: string | undefined;

/**
 * Compute a platform-appropriate cache directory for a given doc ID.
 * macOS: ~/Library/Caches/patchwork-lsp/docs/{docId}
 * Linux: $XDG_CACHE_HOME/patchwork-lsp/docs/{docId} (defaults to ~/.cache)
 */
function cacheDir(docId: string): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "patchwork-lsp", "docs", docId);
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(xdgCache, "patchwork-lsp", "docs", docId);
}

/**
 * Extract the doc ID from a folder URL (strip automerge: prefix if present).
 */
function extractDocId(folderUrl: string): string {
  return folderUrl.startsWith("automerge:") ? folderUrl.slice("automerge:".length) : folderUrl;
}

connection.onInitialize((params) => {
  const initOptions = (params.initializationOptions ?? {}) as InitOptions;
  const folderUrl = initOptions.folderUrl;
  const syncServerUrl = initOptions.syncServerUrl ?? "wss://subduction.sync.inkandswitch.com";
  const debug = initOptions.debug !== false; // default to true

  debugLogger = new DebugLogger(connection, debug);

  // Extract rootDocId from folderUrl
  if (folderUrl) {
    rootDocId = extractDocId(folderUrl);
  }

  // Determine workspace root: client-provided > cache dir > /tmp fallback
  if (params.rootUri) {
    try {
      workspaceRoot = new URL(params.rootUri).pathname;
    } catch {
      workspaceRoot = params.rootUri;
    }
  } else if (params.rootPath) {
    workspaceRoot = params.rootPath;
  } else if (rootDocId) {
    workspaceRoot = cacheDir(rootDocId);
  } else {
    workspaceRoot = "/tmp/automerge-workspace";
  }

  connection.console.info(`Workspace root: ${workspaceRoot}`);
  connection.console.info(`Sync server: ${syncServerUrl}`);
  if (debug) connection.console.info("Debug logging enabled");

  // Always register LSP handlers immediately so the server is responsive
  setupHandlers(
    connection,
    () => fileMapper?.getDocumentResolver(),
    () => bridge,
    () => debugLogger,
    pendingDocs,
    () => workspaceRoot,
    () => rootDocId,
    () => importResolver
  );

  // Always create a repo — needed for import resolution even without a folder
  (async () => {
    const repo = await AutomergeBridge.createRepo(syncServerUrl);
    statusNotifier.watchRepo(repo);

    importResolver = new ImportResolver(
      repo,
      workspaceRoot!,
      (msg) => connection.console.info(`[ImportResolver] ${msg}`)
    );

    if (folderUrl) {
      connection.console.info(`Folder URL: ${folderUrl}`);

      const folderHandle = await repo.find<FolderDoc>(folderUrl as AutomergeUrl);

      fileMapper = new FileMapper(repo, workspaceRoot!, folderHandle);
      await fileMapper.init();
      const resolver = fileMapper.getDocumentResolver();

      bridge = new AutomergeBridge(repo, resolver, connection, statusNotifier, () => debugLogger, {
        diskMaterializer: fileMapper,
        rootDocId,
        workspaceRoot,
        onFileTreeChange: (type, virtualPath) => {
          connection.sendNotification("automerge/fileChanged", {
            type,
            path: virtualPath,
          });
        },
      });

      bridge.watchFolder(folderHandle);

      // Register any documents that were opened while we were connecting
      const pending = pendingDocs.drain();
      for (const [uri, text] of pending) {
        registerDocument(connection, bridge, resolver, uri, text, workspaceRoot);
      }

      const count = resolver.getAllResolved().length;
      statusNotifier.filesLoaded(count);
      connection.console.info(`Loaded ${count} files from FolderDoc`);
    } else {
      connection.console.info(
        "No folderUrl provided. Import resolution is active, but no folder sync."
      );
    }
  })().catch((err) => {
    statusNotifier.error(`Failed to initialize: ${err}`);
    connection.console.error(`Failed to initialize automerge: ${err}`);
  });

  return getInitializeResult();
});

connection.onShutdown(() => {
  if (bridge) {
    bridge.dispose();
  }
  statusNotifier.dispose();
});

connection.listen();
