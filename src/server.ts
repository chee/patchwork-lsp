#!/usr/bin/env node

import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node";
import type { AutomergeUrl } from "@automerge/vanillajs";
import { AutomergeBridge } from "./automerge-bridge.js";
import { FileMapper } from "./file-mapper.js";
import { StatusNotifier } from "./status-notifier.js";
import { DebugLogger } from "./debug-logger.js";
import { setupHandlers, getInitializeResult, registerDocument, PendingDocuments, type InitOptions } from "./lsp-handler.js";
import type { FolderDoc } from "./types.js";

const connection = createConnection(ProposedFeatures.all);
const statusNotifier = new StatusNotifier(connection);
const pendingDocs = new PendingDocuments();

let bridge: AutomergeBridge | undefined;
let fileMapper: FileMapper | undefined;
let debugLogger: DebugLogger;

connection.onInitialize((params) => {
  const initOptions = (params.initializationOptions ?? {}) as InitOptions;
  const folderUrl = initOptions.folderUrl;
  const syncServerUrl = initOptions.syncServerUrl ?? "wss://sync3.automerge.org";
  const debug = initOptions.debug !== false; // default to true

  debugLogger = new DebugLogger(connection, debug);

  // Determine workspace root
  let workspaceRoot: string;
  if (params.rootUri) {
    try {
      workspaceRoot = new URL(params.rootUri).pathname;
    } catch {
      workspaceRoot = params.rootUri;
    }
  } else if (params.rootPath) {
    workspaceRoot = params.rootPath;
  } else {
    workspaceRoot = "/tmp/automerge-workspace";
  }

  connection.console.info(`Workspace root: ${workspaceRoot}`);
  connection.console.info(`Sync server: ${syncServerUrl}`);
  if (debug) connection.console.info("Debug logging enabled");

  // Always register LSP handlers immediately so the server is responsive
  setupHandlers(connection, () => fileMapper, () => bridge, () => debugLogger, pendingDocs);

  if (folderUrl) {
    connection.console.info(`Folder URL: ${folderUrl}`);

    // Initialize automerge in the background — don't block LSP init
    const repo = AutomergeBridge.createRepo(syncServerUrl);
    statusNotifier.watchRepo(repo);

    repo.find<FolderDoc>(folderUrl as AutomergeUrl).then(async (folderHandle) => {
      try {
        fileMapper = new FileMapper(repo, workspaceRoot, folderHandle);
        await fileMapper.init();

        bridge = new AutomergeBridge(repo, fileMapper, connection, statusNotifier, () => debugLogger);
        bridge.watchFolder(folderHandle);

        // Register any documents that were opened while we were connecting
        const pending = pendingDocs.drain();
        for (const [uri, text] of pending) {
          registerDocument(connection, bridge, fileMapper, uri, text);
        }

        const count = fileMapper.getAllMappings().length;
        statusNotifier.filesLoaded(count);
        connection.console.info(`Loaded ${count} files from FolderDoc`);
      } catch (err) {
        statusNotifier.error(`Failed to initialize: ${err}`);
        connection.console.error(`Failed to initialize automerge: ${err}`);
      }
    }).catch((err) => {
      statusNotifier.error(`Failed to find folder: ${err}`);
      connection.console.error(`Failed to find folder document: ${err}`);
    });
  } else {
    connection.console.warn(
      "No folderUrl provided in initializationOptions. Running without automerge sync."
    );
  }

  return getInitializeResult();
});

connection.onShutdown(() => {
  if (bridge) {
    bridge.dispose();
  }
});

connection.listen();
