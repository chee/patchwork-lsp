import {
  Connection,
  TextDocumentSyncKind,
  InitializeResult,
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  DidCloseTextDocumentParams,
} from "vscode-languageserver";
import { splice as amSplice } from "@automerge/vanillajs";
import type { FileMapper } from "./file-mapper.js";
import type { AutomergeBridge } from "./automerge-bridge.js";
import type { DebugLogger } from "./debug-logger.js";
import { lspChangeToSplice, applySplice } from "./edit-converter.js";
import type { UnixFileEntry } from "./types.js";

export interface InitOptions {
  folderUrl: string;
  syncServerUrl: string;
  debug?: boolean;
}

/**
 * Tracks documents that were opened before bridge was ready,
 * so we can register them once it becomes available.
 */
export class PendingDocuments {
  private docs: Map<string, string> = new Map(); // uri -> text

  add(uri: string, text: string): void {
    this.docs.set(uri, text);
  }

  remove(uri: string): void {
    this.docs.delete(uri);
  }

  drain(): Map<string, string> {
    const result = new Map(this.docs);
    this.docs.clear();
    return result;
  }
}

/**
 * Sets up all LSP handlers on the given connection.
 * Uses getter functions for fileMapper and bridge since they may be
 * initialized asynchronously after the server starts.
 */
export function setupHandlers(
  connection: Connection,
  getFileMapper: () => FileMapper | undefined,
  getBridge: () => AutomergeBridge | undefined,
  getDebug: () => DebugLogger | undefined,
  pendingDocs: PendingDocuments
): void {
  connection.onInitialized(() => {
    connection.console.info("Automerge LSP server initialized");
  });

  connection.onDidOpenTextDocument((params: DidOpenTextDocumentParams) => {
    const uri = params.textDocument.uri;
    const text = params.textDocument.text;
    const bridge = getBridge();
    const fileMapper = getFileMapper();

    if (!bridge) {
      // Bridge not ready yet — stash for later
      pendingDocs.add(uri, text);
      return;
    }

    registerDocument(connection, bridge, fileMapper, uri, text);
  });

  connection.onDidChangeTextDocument((params: DidChangeTextDocumentParams) => {
    const uri = params.textDocument.uri;
    const bridge = getBridge();
    const fileMapper = getFileMapper();
    const debug = getDebug();

    if (!bridge) return;

    // If we're currently applying a remote edit to the editor,
    // the didChange is just the echo — update mirror but skip automerge.
    if (bridge.isApplyingRemoteEdit()) {
      let text = bridge.getDocumentText(uri);
      if (text === undefined) return;
      for (const change of params.contentChanges) {
        if (!("range" in change) || !change.range) {
          text = change.text;
        } else {
          const spliceOp = lspChangeToSplice(text, change.range, change.text);
          debug?.guardConsumed(uri, spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);
          text = applySplice(text, spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);
        }
      }
      bridge.setDocumentText(uri, text);
      return;
    }

    let currentText = bridge.getDocumentText(uri);
    if (currentText === undefined) return;

    const mapping = fileMapper?.getByUri(uri);
    if (!mapping) return;

    for (const change of params.contentChanges) {
      if (!("range" in change) || !change.range) {
        // Full document sync — replace everything
        debug?.lspChange(uri, 0, currentText.length, change.text);
        currentText = change.text;
        bridge.setDocumentText(uri, currentText);

        debug?.automergeChange(uri, 0, currentText.length, change.text);
        bridge.applyLocalChange(mapping.docHandle, (doc: UnixFileEntry) => {
          amSplice(doc, ["content"], 0, (doc.content as string).length, change.text);
        });
        continue;
      }

      // Incremental change
      const spliceOp = lspChangeToSplice(currentText, change.range, change.text);

      debug?.lspChange(uri, spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);

      // Apply to automerge (wrapped to suppress local change echo)
      debug?.automergeChange(uri, spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);
      bridge.applyLocalChange(mapping.docHandle, (doc: UnixFileEntry) => {
        if (spliceOp.deleteCount > 0 || spliceOp.insertText.length > 0) {
          amSplice(doc, ["content"], spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);
        }
      });

      // Update our mirror text
      currentText = applySplice(
        currentText,
        spliceOp.offset,
        spliceOp.deleteCount,
        spliceOp.insertText
      );
      bridge.setDocumentText(uri, currentText);
    }

    // Debounced update of lastSyncAt on all parent folders
    bridge.touchParentFolders(mapping.automergeUrl);
  });

  connection.onDidCloseTextDocument((params: DidCloseTextDocumentParams) => {
    const uri = params.textDocument.uri;
    pendingDocs.remove(uri);
    getBridge()?.unwatchDocument(uri);
  });

  connection.onDidSaveTextDocument(() => {
    // No-op — automerge is already up to date from didChange
  });
}

/**
 * Register a document with the bridge (store text + start watching).
 */
export function registerDocument(
  connection: Connection,
  bridge: AutomergeBridge,
  fileMapper: FileMapper | undefined,
  uri: string,
  text: string
): void {
  bridge.setDocumentText(uri, text);

  if (fileMapper) {
    const mapping = fileMapper.getByUri(uri);
    if (mapping) {
      bridge.watchDocument(uri, mapping.docHandle);
      connection.console.info(`Tracking: ${mapping.name}`);
    }
  }
}

/**
 * Returns the InitializeResult for the LSP handshake.
 */
export function getInitializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false },
      },
    },
  };
}
