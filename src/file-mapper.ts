import * as fs from "fs";
import * as path from "path";
import type { Repo, DocHandle, AutomergeUrl } from "@automerge/vanillajs";
import type { FolderDoc, DocLink, UnixFileEntry, FileMapping } from "./types.js";
import { DocumentResolver } from "./document-resolver.js";

/**
 * FileMapper wraps DocumentResolver and adds disk materialization.
 * Public API is unchanged from the original — all existing call sites keep working.
 */
export class FileMapper {
  private resolver: DocumentResolver;
  private workspaceRoot: string;
  private folderHandle: DocHandle<FolderDoc>;

  constructor(repo: Repo, workspaceRoot: string, folderHandle: DocHandle<FolderDoc>) {
    this.workspaceRoot = workspaceRoot;
    this.folderHandle = folderHandle;
    this.resolver = new DocumentResolver(repo, folderHandle);
  }

  /**
   * Initialize mappings from the current FolderDoc state.
   * Resolves all docs via DocumentResolver, then materializes files to disk.
   */
  async init(): Promise<void> {
    await this.resolver.init();
    this.materializeAll();
  }

  /**
   * Write all resolved documents to disk.
   */
  private materializeAll(): void {
    fs.mkdirSync(this.workspaceRoot, { recursive: true });

    for (const resolved of this.resolver.getAllResolved()) {
      const localPath = path.join(this.workspaceRoot, resolved.virtualPath);
      const dir = path.dirname(localPath);
      fs.mkdirSync(dir, { recursive: true });

      const content = this.resolver.readFileContent(resolved.virtualPath);
      if (typeof content === "string") {
        fs.writeFileSync(localPath, content, "utf-8");
      }
    }

    // Also ensure directories exist for folder entries
    const rootEntries = this.resolver.listDirectory("");
    this.materializeDirectories("", rootEntries);
  }

  /**
   * Recursively ensure directories exist on disk.
   */
  private materializeDirectories(prefix: string, entries: { name: string; type: string; virtualPath: string }[]): void {
    for (const entry of entries) {
      if (entry.type === "directory") {
        const localPath = path.join(this.workspaceRoot, entry.virtualPath);
        fs.mkdirSync(localPath, { recursive: true });
        const subEntries = this.resolver.listDirectory(entry.virtualPath);
        this.materializeDirectories(entry.virtualPath, subEntries);
      }
    }
  }

  /**
   * Add a mapping for a single DocLink and materialize the file.
   */
  async addMapping(
    docLink: DocLink,
    basePath: string = this.workspaceRoot,
    parentChain: DocHandle<FolderDoc>[] = [this.folderHandle]
  ): Promise<FileMapping | null> {
    // Compute the virtual path prefix from the basePath
    let parentPrefix = "";
    if (basePath !== this.workspaceRoot) {
      parentPrefix = path.relative(this.workspaceRoot, basePath);
    }

    const resolved = await this.resolver.addEntry(docLink, parentPrefix, parentChain);
    if (!resolved) return null;

    // Materialize to disk
    const localPath = path.join(this.workspaceRoot, resolved.virtualPath);
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });

    const content = this.resolver.readFileContent(resolved.virtualPath);
    if (typeof content === "string") {
      fs.writeFileSync(localPath, content, "utf-8");
    }

    return {
      localPath,
      automergeUrl: resolved.automergeUrl,
      docHandle: resolved.docHandle,
      name: resolved.name,
    };
  }

  /**
   * Remove a mapping and optionally delete the local file.
   */
  removeMapping(localPath: string, deleteFile: boolean = true): void {
    const vpath = path.relative(this.workspaceRoot, localPath);
    this.resolver.removeEntry(vpath);

    if (deleteFile && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }

  /**
   * Get mapping by local file path.
   */
  getByPath(localPath: string): FileMapping | undefined {
    const vpath = path.relative(this.workspaceRoot, localPath);
    const resolved = this.resolver.getByVirtualPath(vpath);
    if (!resolved) return undefined;
    return this.toFileMapping(resolved);
  }

  /**
   * Get mapping by automerge URL.
   */
  getByUrl(url: AutomergeUrl): FileMapping | undefined {
    const resolved = this.resolver.getByUrl(url);
    if (!resolved) return undefined;
    return this.toFileMapping(resolved);
  }

  /**
   * Get mapping by document URI (file:// or automerge: URI).
   */
  getByUri(uri: string): FileMapping | undefined {
    const resolved = this.resolver.getByUri(uri, this.workspaceRoot);
    if (!resolved) return undefined;
    return this.toFileMapping(resolved);
  }

  /**
   * Get all current mappings.
   */
  getAllMappings(): FileMapping[] {
    return this.resolver.getAllResolved().map((r) => this.toFileMapping(r));
  }

  /**
   * Convert a local file path to a file:// URI.
   */
  pathToUri(localPath: string): string {
    return `file://${localPath}`;
  }

  /**
   * Convert a file:// URI to a local file path.
   */
  uriToPath(uri: string): string {
    try {
      return new URL(uri).pathname;
    } catch {
      return uri;
    }
  }

  /**
   * Get the parent folder handles for a file, from immediate parent up to root.
   */
  getParentFolders(url: AutomergeUrl): DocHandle<FolderDoc>[] {
    return this.resolver.getParentFolders(url);
  }

  /**
   * Get the folder doc handle for watching structural changes.
   */
  getFolderHandle(): DocHandle<FolderDoc> {
    return this.folderHandle;
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Get the underlying DocumentResolver for direct access.
   */
  getDocumentResolver(): DocumentResolver {
    return this.resolver;
  }

  /**
   * Convert a ResolvedDocument to a FileMapping.
   */
  private toFileMapping(resolved: { virtualPath: string; automergeUrl: AutomergeUrl; docHandle: DocHandle<UnixFileEntry>; name: string }): FileMapping {
    return {
      localPath: path.join(this.workspaceRoot, resolved.virtualPath),
      automergeUrl: resolved.automergeUrl,
      docHandle: resolved.docHandle,
      name: resolved.name,
    };
  }
}
