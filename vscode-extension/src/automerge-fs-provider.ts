import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
  virtualPath: string;
}

interface FileStat {
  type: "file" | "directory";
  size: number;
  mtime: number;
}

/**
 * FileSystemProvider for the `automerge:` URI scheme.
 * Proxies all operations to the LSP server via custom requests.
 *
 * URI format: automerge:rootDocId/path/to/file.js
 */
export class AutomergeFsProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private getClient: () => LanguageClient | undefined;

  constructor(getClient: () => LanguageClient | undefined) {
    this.getClient = getClient;
  }

  /**
   * Fire file change events (called from extension when LSP notification arrives).
   */
  fireChange(events: vscode.FileChangeEvent[]): void {
    this._onDidChangeFile.fire(events);
  }

  watch(): vscode.Disposable {
    // LSP pushes changes via notifications — no polling needed
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const vpath = uriToVirtualPath(uri);
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("LSP client not ready");
    }

    const result = await client.sendRequest<FileStat | null>("automerge/stat", {
      path: vpath,
    });

    if (!result) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return {
      type: result.type === "directory"
        ? vscode.FileType.Directory
        : vscode.FileType.File,
      ctime: 0,
      mtime: result.mtime,
      size: result.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const vpath = uriToVirtualPath(uri);
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("LSP client not ready");
    }

    const result = await client.sendRequest<{ entries: DirectoryEntry[] }>(
      "automerge/listFiles",
      { path: vpath }
    );

    return result.entries.map((entry) => [
      entry.name,
      entry.type === "directory"
        ? vscode.FileType.Directory
        : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const vpath = uriToVirtualPath(uri);
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("LSP client not ready");
    }

    const result = await client.sendRequest<{ content: string | null }>(
      "automerge/readFile",
      { path: vpath }
    );

    if (result.content === null) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return new TextEncoder().encode(result.content);
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const vpath = uriToVirtualPath(uri);
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("LSP client not ready");
    }

    const text = new TextDecoder().decode(content);
    const result = await client.sendRequest<{ success: boolean }>(
      "automerge/writeFile",
      { path: vpath, content: text }
    );

    if (!result.success) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri },
    ]);
  }

  createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      "Creating directories is not yet supported"
    );
  }

  delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(
      "Deleting files is not yet supported"
    );
  }

  rename(
    _oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { overwrite: boolean }
  ): void {
    throw vscode.FileSystemError.NoPermissions(
      "Renaming files is not yet supported"
    );
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
  }
}

/**
 * Extract the virtual path from an automerge: URI.
 *
 * Preferred format (path-based, case-preserving):
 *   automerge:/<docId>/path/to/file.js  →  "path/to/file.js"
 *   (authority is empty, docId is first path segment)
 *
 * Legacy format (authority-based, VS Code lowercases authority):
 *   automerge://<docId>/path/to/file.js  →  "path/to/file.js"
 *   (authority = docId, entire path is the virtual path)
 */
function uriToVirtualPath(uri: vscode.Uri): string {
  const segments = uri.path.split("/").filter(Boolean);

  if (uri.authority) {
    // Authority-based: doc ID is in authority, path IS the virtual path
    return segments.join("/");
  }

  // Path-based: first segment is doc ID, rest is virtual path
  return segments.slice(1).join("/");
}
