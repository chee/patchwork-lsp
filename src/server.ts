#!/usr/bin/env node

import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node";
import type { AutomergeUrl } from "@automerge/vanillajs";
import { AutomergeBridge } from "./automerge-bridge.js";
import { FileMapper } from "./file-mapper.js";
import { DocumentResolver } from "./document-resolver.js";
import { StatusNotifier } from "./status-notifier.js";
import { DebugLogger } from "./debug-logger.js";
import { setupHandlers, getInitializeResult, registerDocument, PendingDocuments, type InitOptions } from "./lsp-handler.js";
import type { FolderDoc } from "./types.js";

const connection = createConnection(ProposedFeatures.all);
const statusNotifier = new StatusNotifier(connection);
const pendingDocs = new PendingDocuments();

let bridge: AutomergeBridge | undefined;
let fileMapper: FileMapper | undefined;
let resolver: DocumentResolver | undefined;
let debugLogger: DebugLogger;
let workspaceRoot: string | undefined;

connection.onInitialize((params) => {
  const initOptions = (params.initializationOptions ?? {}) as InitOptions;
  const folderUrl = initOptions.folderUrl;
  const syncServerUrl = initOptions.syncServerUrl ?? "wss://sync3.automerge.org";
  const debug = initOptions.debug !== false; // default to true
  const mode = initOptions.mode ?? "fallback";

  debugLogger = new DebugLogger(connection, debug);

  // Determine workspace root
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
  connection.console.info(`Mode: ${mode}`);
  if (debug) connection.console.info("Debug logging enabled");

  // Always register LSP handlers immediately so the server is responsive
  setupHandlers(
    connection,
    () => resolver,
    () => bridge,
    () => debugLogger,
    pendingDocs,
    () => workspaceRoot
  );

  if (folderUrl) {
    connection.console.info(`Folder URL: ${folderUrl}`);

    // Initialize automerge in the background — don't block LSP init
    const repo = AutomergeBridge.createRepo(syncServerUrl);
    statusNotifier.watchRepo(repo);

    repo.find<FolderDoc>(folderUrl as AutomergeUrl).then(async (folderHandle) => {
      try {
        if (mode === "vfs") {
          // VFS mode: DocumentResolver only, no disk writes
          resolver = new DocumentResolver(repo, folderHandle);
          await resolver.init();

          bridge = new AutomergeBridge(repo, resolver, connection, statusNotifier, () => debugLogger, {
            onFileTreeChange: (type, virtualPath) => {
              connection.sendNotification("automerge/fileChanged", {
                type,
                path: virtualPath,
              });
            },
          });
        } else {
          // Fallback mode: FileMapper wraps DocumentResolver, materializes to disk
          fileMapper = new FileMapper(repo, workspaceRoot!, folderHandle);
          await fileMapper.init();
          resolver = fileMapper.getDocumentResolver();

          bridge = new AutomergeBridge(repo, resolver, connection, statusNotifier, () => debugLogger, {
            diskMaterializer: fileMapper,
            onFileTreeChange: (type, virtualPath) => {
              connection.sendNotification("automerge/fileChanged", {
                type,
                path: virtualPath,
              });
            },
          });
        }

        bridge.watchFolder(folderHandle);

        // Register any documents that were opened while we were connecting
        const pending = pendingDocs.drain();
        for (const [uri, text] of pending) {
          registerDocument(connection, bridge, resolver, uri, text, workspaceRoot);
        }

        const count = resolver.getAllResolved().length;
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
