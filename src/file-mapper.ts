import * as fs from "fs";
import * as path from "path";
import type { Repo, DocHandle, AutomergeUrl } from "@automerge/vanillajs";
import type { FolderDoc, DocLink, UnixFileEntry, FileMapping } from "./types.js";

/**
 * FileMapper maintains the bidirectional mapping between local file paths
 * and automerge document URLs/handles.
 */
export class FileMapper {
  private mappings: Map<string, FileMapping> = new Map(); // keyed by localPath
  private urlToPath: Map<AutomergeUrl, string> = new Map();
  // For each file URL, the chain of parent FolderDoc handles (immediate parent first)
  private parentFolders: Map<AutomergeUrl, DocHandle<FolderDoc>[]> = new Map();
  private repo: Repo;
  private workspaceRoot: string;
  private folderHandle: DocHandle<FolderDoc>;

  constructor(repo: Repo, workspaceRoot: string, folderHandle: DocHandle<FolderDoc>) {
    this.repo = repo;
    this.workspaceRoot = workspaceRoot;
    this.folderHandle = folderHandle;
  }

  /**
   * Initialize mappings from the current FolderDoc state.
   * Materializes files locally.
   */
  async init(): Promise<void> {
    await this.loadFolder(this.folderHandle, this.workspaceRoot, []);
  }

  /**
   * Recursively load a folder and its contents, tracking parent chains.
   */
  private async loadFolder(
    folderHandle: DocHandle<FolderDoc>,
    basePath: string,
    parentChain: DocHandle<FolderDoc>[]
  ): Promise<void> {
    const doc = folderHandle.doc();
    if (!doc) throw new Error("FolderDoc not available");

    fs.mkdirSync(basePath, { recursive: true });

    const chain = [folderHandle, ...parentChain];

    for (const docLink of doc.docs) {
      await this.addMapping(docLink, basePath, chain);
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
    const localPath = path.join(basePath, docLink.name);

    // Skip binary types
    if (this.isBinaryType(docLink.type)) {
      return null;
    }

    // If this DocLink is a folder, recurse into it
    if (docLink.type === "folder" || docLink.type === "application/folder") {
      const subFolderHandle = await this.repo.find<FolderDoc>(docLink.url);
      await this.loadFolder(subFolderHandle, localPath, parentChain);
      return null;
    }

    const docHandle = await this.repo.find<UnixFileEntry>(docLink.url);
    const doc = docHandle.doc();
    if (!doc) return null;

    // Materialize file locally
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });

    if (typeof doc.content === "string") {
      fs.writeFileSync(localPath, doc.content, "utf-8");
    }

    const mapping: FileMapping = {
      localPath,
      automergeUrl: docLink.url,
      docHandle,
      name: docLink.name,
    };

    this.mappings.set(localPath, mapping);
    this.urlToPath.set(docLink.url, localPath);
    this.parentFolders.set(docLink.url, parentChain);

    return mapping;
  }

  /**
   * Remove a mapping and optionally delete the local file.
   */
  removeMapping(localPath: string, deleteFile: boolean = true): void {
    const mapping = this.mappings.get(localPath);
    if (!mapping) return;

    this.urlToPath.delete(mapping.automergeUrl);
    this.mappings.delete(localPath);

    if (deleteFile && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }

  /**
   * Get mapping by local file path.
   */
  getByPath(localPath: string): FileMapping | undefined {
    return this.mappings.get(localPath);
  }

  /**
   * Get mapping by automerge URL.
   */
  getByUrl(url: AutomergeUrl): FileMapping | undefined {
    const localPath = this.urlToPath.get(url);
    return localPath ? this.mappings.get(localPath) : undefined;
  }

  /**
   * Get mapping by document URI (file:// URI from LSP).
   */
  getByUri(uri: string): FileMapping | undefined {
    // Convert file:// URI to local path
    let localPath: string;
    try {
      localPath = new URL(uri).pathname;
    } catch {
      localPath = uri;
    }
    return this.mappings.get(localPath);
  }

  /**
   * Get all current mappings.
   */
  getAllMappings(): FileMapping[] {
    return Array.from(this.mappings.values());
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
    return this.parentFolders.get(url) ?? [this.folderHandle];
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

  private isBinaryType(type: string): boolean {
    const binaryTypes = [
      "image/", "audio/", "video/",
      "application/octet-stream",
      "application/zip",
      "application/pdf",
    ];
    return binaryTypes.some((bt) => type.startsWith(bt));
  }
}
