import type { Repo, DocHandle, AutomergeUrl } from "@automerge/vanillajs";
import type {
  FolderDoc,
  DocLink,
  UnixFileEntry,
  ResolvedDocument,
  DirectoryEntry,
  FileStat,
} from "./types.js";

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
   * Recursively walk a FolderDoc, storing mappings for all entries.
   */
  async loadFolder(
    folderHandle: DocHandle<FolderDoc>,
    prefix: string,
    parentChain: DocHandle<FolderDoc>[]
  ): Promise<void> {
    const doc = folderHandle.doc();
    if (!doc) throw new Error("FolderDoc not available");

    const chain = [folderHandle, ...parentChain];

    for (const docLink of doc.docs) {
      await this.addEntry(docLink, prefix, chain);
    }
  }

  /**
   * Add a single entry (file or subfolder) to the resolver.
   */
  async addEntry(
    docLink: DocLink,
    parentPrefix: string,
    parentChain: DocHandle<FolderDoc>[]
  ): Promise<ResolvedDocument | null> {
    const virtualPath = parentPrefix
      ? `${parentPrefix}/${docLink.name}`
      : docLink.name;

    // Skip binary types
    if (this.isBinaryType(docLink.type)) {
      return null;
    }

    // If this is a folder, recurse
    if (docLink.type === "folder" || docLink.type === "application/folder") {
      const subFolderHandle = await this.repo.find<FolderDoc>(docLink.url);
      this.folderHandles.set(virtualPath, subFolderHandle);
      await this.loadFolder(subFolderHandle, virtualPath, parentChain);
      return null;
    }

    const docHandle = await this.repo.find<UnixFileEntry>(docLink.url);
    const doc = docHandle.doc();
    if (!doc) return null;

    const resolved: ResolvedDocument = {
      virtualPath,
      automergeUrl: docLink.url,
      docHandle,
      name: docLink.name,
    };

    this.byVirtualPath.set(virtualPath, resolved);
    this.urlToVirtualPath.set(docLink.url, virtualPath);
    this.parentFolders.set(docLink.url, parentChain);

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
    return typeof doc.content === "string" ? doc.content : undefined;
  }

  /**
   * List directory entries at a given virtual path.
   */
  listDirectory(vpath: string): DirectoryEntry[] {
    const folderHandle = this.folderHandles.get(vpath);
    if (!folderHandle) return [];

    const doc = folderHandle.doc();
    if (!doc) return [];

    const entries: DirectoryEntry[] = [];
    for (const docLink of doc.docs) {
      if (this.isBinaryType(docLink.type)) continue;

      const entryPath = vpath ? `${vpath}/${docLink.name}` : docLink.name;
      const isFolder =
        docLink.type === "folder" || docLink.type === "application/folder";

      entries.push({
        name: docLink.name,
        type: isFolder ? "directory" : "file",
        virtualPath: entryPath,
      });
    }
    return entries;
  }

  /**
   * Get file/directory stat information.
   */
  stat(vpath: string): FileStat | null {
    // Check if it's a folder
    if (this.folderHandles.has(vpath)) {
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
    const content = doc?.content;
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

  private isBinaryType(type: string): boolean {
    const binaryTypes = [
      "image/",
      "audio/",
      "video/",
      "application/octet-stream",
      "application/zip",
      "application/pdf",
    ];
    return binaryTypes.some((bt) => type.startsWith(bt));
  }
}
