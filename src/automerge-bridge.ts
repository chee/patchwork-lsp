import { Repo, WebSocketClientAdapter } from "@automerge/vanillajs";
import type { DocHandle, AutomergeUrl } from "@automerge/vanillajs";
import type { Connection } from "vscode-languageserver";
import { TextEdit } from "vscode-languageserver-protocol";
import type { DocumentResolver } from "./document-resolver.js";
import type { StatusNotifier } from "./status-notifier.js";
import type { DebugLogger } from "./debug-logger.js";
import type { FolderDoc, UnixFileEntry, DocLink, ResolvedDocument } from "./types.js";
import {
  patchToTextEdit,
  positionToOffset,
  applySplice,
  type AutomergePatch,
} from "./edit-converter.js";

const LAST_SYNC_DEBOUNCE_MS = 500;

/**
 * Callback for structural file tree changes (file added/removed).
 */
export type FileTreeChangeCallback = (
  type: "created" | "deleted",
  virtualPath: string,
  resolved?: ResolvedDocument
) => void;

/**
 * Optional disk materializer interface — FileMapper implements this.
 * When present, the bridge delegates disk operations to it.
 */
export interface DiskMaterializer {
  addMapping(docLink: DocLink): Promise<{ localPath: string } | null>;
  removeMapping(localPath: string, deleteFile: boolean): void;
  getByUrl(url: AutomergeUrl): { localPath: string } | undefined;
  pathToUri(localPath: string): string;
}

/**
 * AutomergeBridge manages the automerge-repo connection and watches
 * for remote patches on all tracked documents.
 */
export class AutomergeBridge {
  private repo: Repo;
  private resolver: DocumentResolver;
  private diskMaterializer?: DiskMaterializer;
  private connection: Connection;
  private statusNotifier: StatusNotifier;
  private getDebug: () => DebugLogger | undefined;
  private documentTexts: Map<string, string> = new Map(); // uri -> current text
  private changeListeners: Map<string, () => void> = new Map();
  private onFileTreeChange?: FileTreeChangeCallback;

  // Flag to suppress change events during our own docHandle.change() calls.
  private localChangeInProgress = false;

  // Flag to suppress didChange events during our own workspace/applyEdit calls.
  private _applyingRemoteEdit = false;

  // Debounce timer for lastSyncAt updates, keyed by folder handle identity
  private lastSyncTimers: Map<DocHandle<FolderDoc>, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    repo: Repo,
    resolver: DocumentResolver,
    connection: Connection,
    statusNotifier: StatusNotifier,
    getDebug: () => DebugLogger | undefined,
    options?: {
      diskMaterializer?: DiskMaterializer;
      onFileTreeChange?: FileTreeChangeCallback;
    }
  ) {
    this.repo = repo;
    this.resolver = resolver;
    this.connection = connection;
    this.statusNotifier = statusNotifier;
    this.getDebug = getDebug;
    this.diskMaterializer = options?.diskMaterializer;
    this.onFileTreeChange = options?.onFileTreeChange;
  }

  /**
   * Create and connect an automerge Repo with a websocket adapter.
   */
  static createRepo(syncServerUrl: string): Repo {
    const repo = new Repo({
      network: [new WebSocketClientAdapter(syncServerUrl)],
    });
    return repo;
  }

  /**
   * Set the current text for a document (used by LSP handler to keep mirror in sync).
   */
  setDocumentText(uri: string, text: string): void {
    this.documentTexts.set(uri, text);
  }

  /**
   * Get the current mirror text for a document.
   */
  getDocumentText(uri: string): string | undefined {
    return this.documentTexts.get(uri);
  }

  /**
   * Check if we're currently applying a remote edit to the editor.
   * Used by the LSP handler to suppress didChange echo.
   */
  isApplyingRemoteEdit(): boolean {
    return this._applyingRemoteEdit;
  }

  /**
   * Apply a local change to an automerge doc handle, suppressing the
   * change event so we don't echo it back to the editor.
   */
  applyLocalChange(handle: DocHandle<UnixFileEntry>, callback: (doc: UnixFileEntry) => void): void {
    this.localChangeInProgress = true;
    try {
      handle.change(callback);
    } finally {
      this.localChangeInProgress = false;
    }
    this.statusNotifier.refreshHeads();
  }

  /**
   * Mark all parent folders of a file as recently synced.
   * Debounced — rapid edits coalesce into a single lastSyncAt update per folder.
   */
  touchParentFolders(fileUrl: AutomergeUrl): void {
    const parents = this.resolver.getParentFolders(fileUrl);
    const now = Date.now();

    for (const folderHandle of parents) {
      const existing = this.lastSyncTimers.get(folderHandle);
      if (existing) clearTimeout(existing);

      this.lastSyncTimers.set(
        folderHandle,
        setTimeout(() => {
          this.lastSyncTimers.delete(folderHandle);
          this.localChangeInProgress = true;
          try {
            folderHandle.change((doc: FolderDoc) => {
              doc.lastSyncAt = now;
            });
          } finally {
            this.localChangeInProgress = false;
          }
        }, LAST_SYNC_DEBOUNCE_MS)
      );
    }
  }

  /**
   * Start watching a document handle for remote changes.
   */
  watchDocument(uri: string, handle: DocHandle<UnixFileEntry>): void {
    const onChange = ({ doc, patches }: { doc: UnixFileEntry; patches: any[] }) => {
      if (this.localChangeInProgress) return;
      this.handleRemotePatches(uri, doc, patches as AutomergePatch[]);
    };

    handle.on("change", onChange);
    this.changeListeners.set(uri, () => handle.off("change", onChange));
    this.statusNotifier.trackDocument(uri, handle);
  }

  /**
   * Stop watching a document.
   */
  unwatchDocument(uri: string): void {
    const cleanup = this.changeListeners.get(uri);
    if (cleanup) {
      cleanup();
      this.changeListeners.delete(uri);
    }
    this.statusNotifier.untrackDocument(uri);
  }

  /**
   * Handle incoming automerge patches for a document.
   * Converts them to LSP edits and pushes to the editor.
   */
  private async handleRemotePatches(uri: string, doc: UnixFileEntry, patches: AutomergePatch[]): Promise<void> {
    const debug = this.getDebug();
    const currentText = this.documentTexts.get(uri);
    if (currentText === undefined) return;

    const contentPatches = patches.filter((p) => p.path[0] === "content");

    debug?.remotePatch(uri, patches.length, contentPatches.length);

    if (contentPatches.length === 0) return;

    // Send file changed notification for content changes
    this.onFileTreeChange?.("changed" as any, uri);

    const hasPut = contentPatches.some((p) => p.action === "put" && p.path.length === 1);
    if (hasPut) {
      const newContent = typeof doc.content === "string" ? doc.content : "";
      debug?.log("patch", "put detected — full replacement", {
        oldLen: currentText.length,
        newLen: newContent.length,
      });

      if (newContent === currentText) return;

      const lastLine = currentText.split("\n");
      const endPos = {
        line: lastLine.length - 1,
        character: lastLine[lastLine.length - 1].length,
      };

      const edits: TextEdit[] = [{
        range: { start: { line: 0, character: 0 }, end: endPos },
        newText: newContent,
      }];

      this.documentTexts.set(uri, newContent);
      this.statusNotifier.syncing();

      debug?.editorApplyEdit(uri, 1);

      this._applyingRemoteEdit = true;
      try {
        await this.connection.workspace.applyEdit({
          label: "Automerge remote edit",
          edit: { changes: { [uri]: edits } },
        });
      } catch (err) {
        this.connection.console.error(`Failed to apply remote edit: ${err}`);
      } finally {
        this._applyingRemoteEdit = false;
      }
      return;
    }

    // Incremental patches
    let text = currentText;
    const edits: TextEdit[] = [];

    for (const patch of contentPatches) {
      debug?.log("patch", `${patch.action} path=${JSON.stringify(patch.path)}`, {
        value: patch.value ? (patch.value.length > 80 ? patch.value.slice(0, 80) + `...(${patch.value.length} chars)` : patch.value) : undefined,
        length: patch.length,
        mirrorLen: text.length,
      });

      const edit = patchToTextEdit(text, patch);
      if (!edit) {
        debug?.log("patch", "skipped (no edit produced)");
        continue;
      }

      debug?.log("patch", "→ TextEdit", {
        rangeStart: `${edit.range.start.line}:${edit.range.start.character}`,
        rangeEnd: `${edit.range.end.line}:${edit.range.end.character}`,
        newText: edit.newText.length > 80 ? edit.newText.slice(0, 80) + `...(${edit.newText.length} chars)` : edit.newText,
      });

      edits.push(edit);

      const offset = positionToOffset(text, edit.range.start);
      const endOffset = positionToOffset(text, edit.range.end);
      text = applySplice(text, offset, endOffset - offset, edit.newText);
    }

    if (edits.length === 0) return;

    this.statusNotifier.syncing();
    this.documentTexts.set(uri, text);

    debug?.editorApplyEdit(uri, edits.length);

    this._applyingRemoteEdit = true;
    try {
      await this.connection.workspace.applyEdit({
        label: "Automerge remote edit",
        edit: {
          changes: {
            [uri]: edits,
          },
        },
      });
    } catch (err) {
      this.connection.console.error(`Failed to apply remote edit: ${err}`);
    } finally {
      this._applyingRemoteEdit = false;
    }
  }

  /**
   * Watch the FolderDoc for structural changes (files added/removed/renamed).
   */
  watchFolder(folderHandle: DocHandle<FolderDoc>): void {
    const initialDoc = folderHandle.doc();
    let previousDocs: DocLink[] = initialDoc ? [...initialDoc.docs] : [];

    folderHandle.on("change", ({ doc }) => {
      if (this.localChangeInProgress) return;
      const currentDocs = doc.docs;
      this.handleFolderChanges(previousDocs, currentDocs);
      previousDocs = [...currentDocs];
    });
  }

  /**
   * Handle structural changes to the folder (file add/remove/rename).
   */
  private async handleFolderChanges(
    previous: DocLink[],
    current: DocLink[]
  ): Promise<void> {
    const prevUrls = new Set(previous.map((d) => d.url));
    const currUrls = new Set(current.map((d) => d.url));

    // Files added
    for (const docLink of current) {
      if (!prevUrls.has(docLink.url)) {
        // Add to resolver
        const rootFolderHandle = this.resolver.getRootFolderHandle();
        const resolved = await this.resolver.addEntry(docLink, "", [rootFolderHandle]);

        // Also materialize to disk if we have a disk materializer
        if (this.diskMaterializer) {
          await this.diskMaterializer.addMapping(docLink);
        }

        if (resolved) {
          this.connection.console.info(`Remote file added: ${docLink.name}`);
          this.onFileTreeChange?.("created", resolved.virtualPath, resolved);
        }
      }
    }

    // Files removed
    for (const docLink of previous) {
      if (!currUrls.has(docLink.url)) {
        const resolved = this.resolver.getByUrl(docLink.url);
        if (resolved) {
          // Unwatch if open in editor
          // In fallback mode, construct a file:// URI
          if (this.diskMaterializer) {
            const diskMapping = this.diskMaterializer.getByUrl(docLink.url);
            if (diskMapping) {
              this.unwatchDocument(this.diskMaterializer.pathToUri(diskMapping.localPath));
              this.diskMaterializer.removeMapping(diskMapping.localPath, true);
            }
          }

          const vpath = resolved.virtualPath;
          this.resolver.removeEntry(vpath);
          this.connection.console.info(`Remote file removed: ${docLink.name}`);
          this.onFileTreeChange?.("deleted", vpath);
        }
      }
    }
  }

  /**
   * Clean up all watchers.
   */
  dispose(): void {
    for (const cleanup of this.changeListeners.values()) {
      cleanup();
    }
    for (const timer of this.lastSyncTimers.values()) {
      clearTimeout(timer);
    }
    this.changeListeners.clear();
    this.lastSyncTimers.clear();
    this.documentTexts.clear();
  }
}
