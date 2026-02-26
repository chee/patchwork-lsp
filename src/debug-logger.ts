import type { Connection } from "vscode-languageserver";

/**
 * Debug logger that can be toggled on/off via initializationOptions.
 * When enabled, logs detailed info about edits flowing through the system.
 */
export class DebugLogger {
  private connection: Connection;
  private enabled: boolean;

  constructor(connection: Connection, enabled: boolean = false) {
    this.connection = connection;
    this.enabled = enabled;
  }

  log(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const parts = [`[DEBUG:${category}] ${message}`];
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        parts.push(`  ${key}: ${JSON.stringify(value)}`);
      }
    }
    this.connection.console.info(parts.join("\n"));
  }

  /** Log when an LSP didChange arrives */
  lspChange(uri: string, offset: number, deleteCount: number, insertText: string): void {
    this.log("lsp-in", `didChange ${shortUri(uri)}`, {
      offset,
      deleteCount,
      insertText: truncate(insertText),
    });
  }

  /** Log when the feedback guard consumes a change */
  guardConsumed(uri: string, offset: number, deleteCount: number, insertText: string): void {
    this.log("guard", `consumed (echo suppressed) ${shortUri(uri)}`, {
      offset,
      deleteCount,
      insertText: truncate(insertText),
    });
  }

  /** Log when the feedback guard passes a change through */
  guardPassthrough(uri: string, offset: number, deleteCount: number, insertText: string, pendingCount: number): void {
    this.log("guard", `passthrough → automerge ${shortUri(uri)}`, {
      offset,
      deleteCount,
      insertText: truncate(insertText),
      pendingExpectations: pendingCount,
    });
  }

  /** Log when the feedback guard discards stale expectations */
  guardStaleDiscard(uri: string, offset: number, deleteCount: number, insertText: string): void {
    this.log("guard", `stale expectations discarded ${shortUri(uri)}`, {
      offset,
      deleteCount,
      insertText: truncate(insertText),
    });
  }

  /** Log when a change is sent to automerge */
  automergeChange(uri: string, offset: number, deleteCount: number, insertText: string): void {
    this.log("am-out", `splice → automerge ${shortUri(uri)}`, {
      offset,
      deleteCount,
      insertText: truncate(insertText),
    });
  }

  /** Log when remote patches arrive from automerge */
  remotePatch(uri: string, patchCount: number, contentPatchCount: number): void {
    this.log("am-in", `remote patches ${shortUri(uri)}`, {
      totalPatches: patchCount,
      contentPatches: contentPatchCount,
    });
  }

  /** Log when we push edits to the editor */
  editorApplyEdit(uri: string, editCount: number): void {
    this.log("lsp-out", `applyEdit → editor ${shortUri(uri)}`, {
      editCount,
    });
  }

  /** Log when we register feedback guard expectations */
  guardExpect(uri: string, offset: number, deleteCount: number, insertText: string): void {
    this.log("guard", `expect ${shortUri(uri)}`, {
      offset,
      deleteCount,
      insertText: truncate(insertText),
    });
  }

  /** Log peer events */
  peerEvent(event: string, peerCount: number): void {
    this.log("network", event, { peerCount });
  }
}

function shortUri(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] || uri;
}

function truncate(text: string, maxLen: number = 50): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `... (${text.length} chars)`;
}
