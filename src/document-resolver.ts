import type { Repo, DocHandle, AutomergeUrl } from "@automerge/automerge-repo";
import type {
  FolderDoc,
  UnixFileEntry,
  ResolvedDocument,
  DirectoryEntry,
  FileStat,
} from "./types.js";
import {
  type DirEntry,
  directoryEntries,
  isFolderish,
  isDirectoryDoc,
  isBinaryMime,
  normalizeAutomergeUrl,
  contentToString,
} from "./folder-format.js";

/**
 * DocumentResolver handles all URI-to-DocHandle resolution without any disk I/O.
 * It maintains bidirectional maps between virtual paths and Automerge URLs/handles.
 */
export class DocumentResolver {
  private byVirtualPath: Map<string, ResolvedDocument> = new Map();
  private urlToVirtualPath: Map<AutomergeUrl, string> = new Map();
  private parentFolders: Map<AutomergeUrl, DocHandle<FolderDoc>[]> = new Map();
  // Track folder structure: virtualPath -> { folderHandle, entries (DocLink[]) }
  private folderHandles: Map<string, DocHandle<FolderDoc>> = new Map();

  private repo: Repo;
  private rootFolderHandle: DocHandle<FolderDoc>;

  constructor(repo: Repo, rootFolderHandle: DocHandle<FolderDoc>) {
    this.repo = repo;
    this.rootFolderHandle = rootFolderHandle;
    // Root folder at ""
    this.folderHandles.set("", rootFolderHandle);
  }

  /**
   * Initialize by walking the folder tree from the root.
   */
  async init(): Promise<void> {
    await this.loadFolder(this.rootFolderHandle, "", []);
  }

  /**
   * Recursively walk a directory document, storing mappings for all entries.
   * Handles both the "docs array" and pushwork "flat map" folder shapes.
   */
  async loadFolder(
    folderHandle: DocHandle<FolderDoc>,
    prefix: string,
    parentChain: DocHandle<FolderDoc>[]
  ): Promise<void> {
    const doc = folderHandle.doc();
    if (!doc) throw new Error("FolderDoc not available");

    const chain = [folderHandle, ...parentChain];

    for (const entry of directoryEntries(doc)) {
      await this.addEntry(entry, prefix, chain);
    }
  }

  /**
   * Add a single entry (file or subfolder) to the resolver.
   *
   * The file-vs-folder decision is made from the resolved child document
   * (its `@patchwork` tag / shape) rather than trusting the parent's hint, so
   * both folder encodings and nested directories are handled uniformly.
   */
  async addEntry(
    entry: DirEntry,
    parentPrefix: string,
    parentChain: DocHandle<FolderDoc>[]
  ): Promise<ResolvedDocument | null> {
    const virtualPath = parentPrefix
      ? `${parentPrefix}/${entry.name}`
      : entry.name;

    // Skip binary entries early when the format tells us the mime type.
    if (entry.type && isBinaryMime(entry.type)) return null;

    const url = normalizeAutomergeUrl(entry.url);
    const handle = await this.repo.find<any>(url);
    const doc = handle.doc();
    if (!doc) return null;

    // Subfolder: recurse.
    if (isFolderish(entry.type) || isDirectoryDoc(doc)) {
      this.folderHandles.set(virtualPath, handle as DocHandle<FolderDoc>);
      await this.loadFolder(handle as DocHandle<FolderDoc>, virtualPath, parentChain);
      return null;
    }

    // File: skip binary content (only text files are materialized/editable).
    if (isBinaryMime(doc.mimeType) || doc.content instanceof Uint8Array) {
      return null;
    }

    const displayName = entry.name.split("/").pop() ?? entry.name;
    const resolved: ResolvedDocument = {
      virtualPath,
      automergeUrl: url,
      docHandle: handle as DocHandle<UnixFileEntry>,
      name: displayName,
    };

    this.byVirtualPath.set(virtualPath, resolved);
    this.urlToVirtualPath.set(url, virtualPath);
    this.parentFolders.set(url, parentChain);

    return resolved;
  }

  /**
   * Remove an entry by virtual path.
   */
  removeEntry(virtualPath: string): void {
    const resolved = this.byVirtualPath.get(virtualPath);
    if (!resolved) return;

    this.urlToVirtualPath.delete(resolved.automergeUrl);
    this.parentFolders.delete(resolved.automergeUrl);
    this.byVirtualPath.delete(virtualPath);
  }

  /**
   * Get a resolved document by virtual path (e.g. "src/index.ts").
   */
  getByVirtualPath(vpath: string): ResolvedDocument | undefined {
    return this.byVirtualPath.get(vpath);
  }

  /**
   * Get a resolved document by Automerge URL.
   */
  getByUrl(url: AutomergeUrl): ResolvedDocument | undefined {
    const vpath = this.urlToVirtualPath.get(url);
    return vpath !== undefined ? this.byVirtualPath.get(vpath) : undefined;
  }

  /**
   * Get a resolved document by URI.
   * Handles both automerge: and file:// schemes.
   * For file:// URIs, the workspaceRoot must be provided to strip the prefix.
   */
  getByUri(uri: string, workspaceRoot?: string): ResolvedDocument | undefined {
    const vpath = this.uriToVirtualPath(uri, workspaceRoot);
    return vpath !== undefined ? this.byVirtualPath.get(vpath) : undefined;
  }

  /**
   * Convert a URI to a virtual path.
   */
  uriToVirtualPath(uri: string, workspaceRoot?: string): string | undefined {
    // Handle automerge: URIs:
    //   automerge:/<docId>/path/to/file.js    (path format — preferred)
    //   automerge://<docId>/path/to/file.js   (authority format — legacy)
    //   automerge:<docId>/path/to/file.js     (opaque format)
    // In all cases, the first segment after scheme is the docId, rest is virtual path.
    if (uri.startsWith("automerge:")) {
      let rest = uri.slice("automerge:".length);
      // Normalize: strip leading slashes
      while (rest.startsWith("/")) rest = rest.slice(1);
      // Now rest = "<docId>/path/to/file.js" or "<docId>/" or "<docId>"
      const segments = rest.split("/").filter(Boolean);
      // First segment is the doc ID, rest is virtual path
      return segments.slice(1).join("/");
    }

    // file:// URI — strip workspace root
    if (uri.startsWith("file://") && workspaceRoot) {
      let localPath: string;
      try {
        localPath = new URL(uri).pathname;
      } catch {
        localPath = uri;
      }
      if (localPath.startsWith(workspaceRoot)) {
        let vpath = localPath.slice(workspaceRoot.length);
        if (vpath.startsWith("/")) vpath = vpath.slice(1);
        return vpath;
      }
    }

    return undefined;
  }

  /**
   * Read file content from a doc handle (no disk I/O).
   */
  readFileContent(vpath: string): string | undefined {
    const resolved = this.byVirtualPath.get(vpath);
    if (!resolved) return undefined;
    const doc = resolved.docHandle.doc();
    if (!doc) return undefined;
    return contentToString(doc.content);
  }

  /**
   * List the immediate children at a given virtual path.
   *
   * Derived from the resolved file map (plus any known subfolder handles) so it
   * works regardless of the underlying folder-doc shape — including the pushwork
   * flat-map format where nested directories are only implied by "/" in keys.
   */
  listDirectory(vpath: string): DirectoryEntry[] {
    const prefix = vpath ? `${vpath}/` : "";
    const names = new Map<string, "file" | "directory">();

    for (const key of this.byVirtualPath.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) names.set(rest, "file");
      else names.set(rest.slice(0, slash), "directory");
    }

    for (const key of this.folderHandles.keys()) {
      if (key === "" || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && rest.indexOf("/") === -1) names.set(rest, "directory");
    }

    return Array.from(names, ([name, type]) => ({
      name,
      type,
      virtualPath: `${prefix}${name}`,
    }));
  }

  /**
   * Get file/directory stat information.
   */
  stat(vpath: string): FileStat | null {
    // Check if it's a folder — either a known folder handle, or an implied
    // directory (some resolved file path lives beneath it).
    const isImpliedDir =
      this.folderHandles.has(vpath) ||
      (vpath !== "" &&
        Array.from(this.byVirtualPath.keys()).some((k) =>
          k.startsWith(`${vpath}/`)
        ));
    if (isImpliedDir) {
      return {
        type: "directory",
        size: 0,
        mtime: Date.now(),
      };
    }

    // Check if it's a file
    const resolved = this.byVirtualPath.get(vpath);
    if (!resolved) return null;

    const doc = resolved.docHandle.doc();
    const content = contentToString(doc?.content);
    const size =
      typeof content === "string"
        ? new TextEncoder().encode(content).byteLength
        : 0;

    return {
      type: "file",
      size,
      mtime: Date.now(),
    };
  }

  /**
   * Get all resolved documents.
   */
  getAllResolved(): ResolvedDocument[] {
    return Array.from(this.byVirtualPath.values());
  }

  /**
   * Get the parent folder handles for a file URL.
   */
  getParentFolders(url: AutomergeUrl): DocHandle<FolderDoc>[] {
    return this.parentFolders.get(url) ?? [this.rootFolderHandle];
  }

  /**
   * Get the root folder handle.
   */
  getRootFolderHandle(): DocHandle<FolderDoc> {
    return this.rootFolderHandle;
  }

  /**
   * Get a subfolder handle by virtual path.
   */
  getFolderHandle(vpath: string): DocHandle<FolderDoc> | undefined {
    return this.folderHandles.get(vpath);
  }

  /**
   * Get the repo instance.
   */
  getRepo(): Repo {
    return this.repo;
  }
}
