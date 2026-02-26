import {
  Connection,
  TextDocumentSyncKind,
  InitializeResult,
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  DidCloseTextDocumentParams,
} from "vscode-languageserver";
import { splice as amSplice } from "@automerge/vanillajs";
import type { DocumentResolver } from "./document-resolver.js";
import type { AutomergeBridge } from "./automerge-bridge.js";
import type { DebugLogger } from "./debug-logger.js";
import { lspChangeToSplice, applySplice } from "./edit-converter.js";
import type { UnixFileEntry } from "./types.js";

export interface InitOptions {
  folderUrl: string;
  syncServerUrl: string;
  debug?: boolean;
  mode?: "vfs" | "fallback";
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
 * Uses getter functions for resolver and bridge since they may be
 * initialized asynchronously after the server starts.
 */
export function setupHandlers(
  connection: Connection,
  getResolver: () => DocumentResolver | undefined,
  getBridge: () => AutomergeBridge | undefined,
  getDebug: () => DebugLogger | undefined,
  pendingDocs: PendingDocuments,
  getWorkspaceRoot: () => string | undefined
): void {
  connection.onInitialized(() => {
    connection.console.info("Automerge LSP server initialized");
  });

  connection.onDidOpenTextDocument((params: DidOpenTextDocumentParams) => {
    const uri = params.textDocument.uri;
    const text = params.textDocument.text;
    const bridge = getBridge();
    const resolver = getResolver();

    if (!bridge) {
      pendingDocs.add(uri, text);
      return;
    }

    registerDocument(connection, bridge, resolver, uri, text, getWorkspaceRoot());
  });

  connection.onDidChangeTextDocument((params: DidChangeTextDocumentParams) => {
    const uri = params.textDocument.uri;
    const bridge = getBridge();
    const resolver = getResolver();
    const debug = getDebug();

    if (!bridge) return;

    if (bridge.isApplyingRemoteEdit()) {
      debug?.guardConsumed(uri, 0, 0, "(remote echo suppressed)");
      return;
    }

    let currentText = bridge.getDocumentText(uri);
    if (currentText === undefined) return;

    const resolved = resolver?.getByUri(uri, getWorkspaceRoot());
    if (!resolved) return;

    for (const change of params.contentChanges) {
      if (!("range" in change) || !change.range) {
        debug?.lspChange(uri, 0, currentText.length, change.text);
        currentText = change.text;
        bridge.setDocumentText(uri, currentText);

        debug?.automergeChange(uri, 0, currentText.length, change.text);
        bridge.applyLocalChange(resolved.docHandle, (doc: UnixFileEntry) => {
          amSplice(doc, ["content"], 0, (doc.content as string).length, change.text);
        });
        continue;
      }

      const spliceOp = lspChangeToSplice(currentText, change.range, change.text);

      debug?.lspChange(uri, spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);

      debug?.automergeChange(uri, spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);
      bridge.applyLocalChange(resolved.docHandle, (doc: UnixFileEntry) => {
        if (spliceOp.deleteCount > 0 || spliceOp.insertText.length > 0) {
          amSplice(doc, ["content"], spliceOp.offset, spliceOp.deleteCount, spliceOp.insertText);
        }
      });

      currentText = applySplice(
        currentText,
        spliceOp.offset,
        spliceOp.deleteCount,
        spliceOp.insertText
      );
      bridge.setDocumentText(uri, currentText);
    }

    bridge.touchParentFolders(resolved.automergeUrl);
  });

  connection.onDidCloseTextDocument((params: DidCloseTextDocumentParams) => {
    const uri = params.textDocument.uri;
    pendingDocs.remove(uri);
    getBridge()?.unwatchDocument(uri);
  });

  connection.onDidSaveTextDocument(() => {
    // No-op — automerge is already up to date from didChange
  });

  // --- Custom VFS requests ---

  connection.onRequest("automerge/listFiles", (params: { path?: string }) => {
    const resolver = getResolver();
    if (!resolver) return { entries: [] };
    const vpath = params.path ?? "";
    return { entries: resolver.listDirectory(vpath) };
  });

  connection.onRequest("automerge/readFile", (params: { path: string }) => {
    const resolver = getResolver();
    if (!resolver) return { content: null };
    const content = resolver.readFileContent(params.path);
    return { content: content ?? null };
  });

  connection.onRequest("automerge/stat", (params: { path: string }) => {
    const resolver = getResolver();
    if (!resolver) return null;
    return resolver.stat(params.path);
  });

  connection.onRequest("automerge/writeFile", (params: { path: string; content: string }) => {
    const resolver = getResolver();
    const bridge = getBridge();
    if (!resolver || !bridge) return { success: false };

    const resolved = resolver.getByVirtualPath(params.path);
    if (!resolved) return { success: false };

    bridge.applyLocalChange(resolved.docHandle, (doc: UnixFileEntry) => {
      amSplice(doc, ["content"], 0, (doc.content as string).length, params.content);
    });

    return { success: true };
  });
}

/**
 * Register a document with the bridge (store text + start watching).
 */
export function registerDocument(
  connection: Connection,
  bridge: AutomergeBridge,
  resolver: DocumentResolver | undefined,
  uri: string,
  text: string,
  workspaceRoot?: string
): void {
  bridge.setDocumentText(uri, text);

  if (resolver) {
    const resolved = resolver.getByUri(uri, workspaceRoot);
    if (resolved) {
      bridge.watchDocument(uri, resolved.docHandle);
      connection.console.info(`Tracking: ${resolved.name}`);
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
