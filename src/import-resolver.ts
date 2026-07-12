import * as fs from "fs";
import * as path from "path";
import type { Repo, DocHandle, AutomergeUrl } from "@automerge/automerge-repo";
import {
  vfsShape,
  patchworkFolderShape,
  type VfsNode,
  type UnixFileEntry,
} from "pushwork";

/**
 * Regex to detect imports from automerge document URLs, with optional subpaths.
 * Matches all forms:
 *   import ... from "/automerge%3A<docId>"
 *   import ... from "/automerge%3a<docId>"
 *   import ... from "/automerge:<docId>"
 *   import ... from "/automerge:<docId>#heads=<hash>"
 *   import ... from "/automerge:<docId>/path/to/file.js"
 *   import ... from "/automerge%3A<docId>/path/to/file.js"
 */
const AUTOMERGE_IMPORT_RE =
  /import\s+.*?\s+from\s+["']\/(automerge(?:%3[Aa]|:)[^"']+)["']/g;

interface ParsedSpecifier {
  /** The full automerge URL (with heads, without subpath) */
  url: AutomergeUrl;
  /** The doc ID portion (with heads, for materialization directory naming) */
  docId: string;
  /** The base doc ID (without heads, for document fetching) */
  baseDocId: string;
  /** Optional subpath within the document tree */
  subpath: string | undefined;
}

/**
 * ImportResolver detects automerge imports in source files, fetches the
 * referenced documents, walks their file trees, and materializes type
 * declarations so TypeScript's intellisense can resolve the imports.
 */
export class ImportResolver {
  private repo: Repo;
  private workspaceRoot: string;
  /** Tracks which documents have been fetched and materialized (keyed by docId) */
  private fetchedDocs: Map<string, { files: { path: string; content: string }[] }> = new Map();
  /** Tracks which import specifiers have had declarations generated */
  private declaredSpecifiers: Set<string> = new Set();
  /** Whether we've already ensured TypeScript config includes .patchwork */
  private configEnsured = false;
  private logFn?: (msg: string) => void;

  constructor(repo: Repo, workspaceRoot: string, logFn?: (msg: string) => void) {
    this.repo = repo;
    this.workspaceRoot = workspaceRoot;
    this.logFn = logFn;
  }

  /**
   * Scan document text for automerge import specifiers.
   * Returns the set of specifiers found (e.g. "automerge%3AHaCF.../dist/index.js").
   */
  scanImports(text: string): Set<string> {
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    AUTOMERGE_IMPORT_RE.lastIndex = 0;
    while ((match = AUTOMERGE_IMPORT_RE.exec(text)) !== null) {
      found.add(match[1]);
    }
    return found;
  }

  /**
   * Resolve any new automerge imports found in the document text.
   * Skips already-declared specifiers. Runs in the background.
   */
  async resolveNewImports(text: string): Promise<void> {
    const specifiers = this.scanImports(text);
    for (const specifier of specifiers) {
      if (this.declaredSpecifiers.has(specifier)) continue;
      this.declaredSpecifiers.add(specifier);

      this.resolveSpecifier(specifier).catch((err) => {
        this.logFn?.(`Failed to resolve import ${specifier}: ${err}`);
        this.declaredSpecifiers.delete(specifier);
      });
    }
  }

  /**
   * Parse a captured specifier into its component parts.
   *
   * Handles formats like:
   *   "automerge:docId"
   *   "automerge%3AdocId"
   *   "automerge:docId/subpath"
   *   "automerge:docId#heads=abc/subpath"
   */
  private parseSpecifier(specifier: string): ParsedSpecifier {
    const decoded = decodeURIComponent(specifier);
    // Split on first "/" after the "automerge:" prefix to separate URL from subpath
    const prefixLen = "automerge:".length;
    const slashIdx = decoded.indexOf("/", prefixLen);

    let urlPart: string;
    let subpath: string | undefined;

    if (slashIdx !== -1) {
      urlPart = decoded.slice(0, slashIdx);
      subpath = decoded.slice(slashIdx + 1);
    } else {
      urlPart = decoded;
    }

    const docId = urlPart.replace(/^automerge:/, "");
    const baseDocId = docId.split("#")[0];

    return {
      url: urlPart as AutomergeUrl,
      docId,
      baseDocId,
      subpath,
    };
  }

  /**
   * Resolve a single import specifier: fetch the document if needed,
   * then generate the declaration for this specifier.
   */
  private async resolveSpecifier(specifier: string): Promise<void> {
    const parsed = this.parseSpecifier(specifier);

    // Fetch and materialize the document if we haven't already
    if (!this.fetchedDocs.has(parsed.docId)) {
      await this.fetchAndMaterialize(parsed);
    }

    const cached = this.fetchedDocs.get(parsed.docId);
    if (!cached) return;

    this.updateDeclarationFile(specifier, parsed, cached.files);
  }

  /**
   * Fetch an automerge document, walk its tree, materialize files
   * to disk, and set up a change watcher.
   */
  private async fetchAndMaterialize(parsed: ParsedSpecifier): Promise<void> {
    this.logFn?.(`Fetching automerge document: ${parsed.url}`);

    const handle = await this.repo.find(parsed.url);
    const doc = handle.doc();
    if (!doc) {
      this.logFn?.(`Document not available: ${parsed.url}`);
      return;
    }

    const tree = await this.decodeDocTree(handle, doc);
    if (!tree) return;

    const files = await this.collectFiles(tree);
    const targetDir = path.join(this.workspaceRoot, ".patchwork", parsed.docId);
    this.materializeFiles(targetDir, files);

    this.fetchedDocs.set(parsed.docId, { files });
    this.ensureTypeScriptConfig();

    // Watch for changes and re-materialize
    handle.on("change", async () => {
      try {
        const updatedDoc = handle.doc();
        if (!updatedDoc) return;
        const updatedTree = await this.decodeDocTree(handle, updatedDoc);
        if (!updatedTree) return;
        const updatedFiles = await this.collectFiles(updatedTree);
        this.materializeFiles(targetDir, updatedFiles);
        this.fetchedDocs.set(parsed.docId, { files: updatedFiles });

        // Re-generate declarations for all specifiers using this doc
        for (const spec of this.declaredSpecifiers) {
          const p = this.parseSpecifier(spec);
          if (p.docId === parsed.docId) {
            this.updateDeclarationFile(spec, p, updatedFiles);
          }
        }
      } catch (err) {
        this.logFn?.(`Failed to update materialized files for ${parsed.docId}: ${err}`);
      }
    });

    this.logFn?.(`Fetched automerge document: ${parsed.url} (${files.length} files)`);
  }

  /**
   * Detect the document shape and decode its tree structure.
   */
  private async decodeDocTree(
    handle: DocHandle<unknown>,
    doc: unknown
  ): Promise<VfsNode | null> {
    const meta = (doc as any)?.["@patchwork"];
    let shape;
    if (meta?.type === "directory") {
      shape = vfsShape;
    } else if (meta?.type === "folder") {
      shape = patchworkFolderShape;
    } else {
      this.logFn?.(`Unknown @patchwork type: ${meta?.type ?? "<missing>"}, skipping`);
      return null;
    }

    return shape.decode({ repo: this.repo, root: handle });
  }

  /**
   * Walk a VfsNode tree and collect all file entries with their content.
   */
  private async collectFiles(
    node: VfsNode,
    prefix: string[] = []
  ): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = [];

    if (node.kind === "file") {
      const handle = await this.repo.find<UnixFileEntry>(node.url);
      const doc = handle.doc();
      if (doc) {
        const content =
          typeof doc.content === "string"
            ? doc.content
            : doc.content instanceof Uint8Array
              ? new TextDecoder().decode(doc.content)
              : String(doc.content);
        files.push({ path: prefix.join("/"), content });
      }
      return files;
    }

    for (const [name, child] of node.entries) {
      const childFiles = await this.collectFiles(child, [...prefix, name]);
      files.push(...childFiles);
    }

    return files;
  }

  /**
   * Ensure that a tsconfig.json or jsconfig.json exists and includes
   * the .patchwork directory so TypeScript picks up the declarations.
   */
  private ensureTypeScriptConfig(): void {
    if (this.configEnsured) return;
    this.configEnsured = true;

    const tsConfigPath = path.join(this.workspaceRoot, "tsconfig.json");
    const jsConfigPath = path.join(this.workspaceRoot, "jsconfig.json");

    // If tsconfig.json exists, check if .patchwork is included
    if (fs.existsSync(tsConfigPath)) {
      this.ensureInclude(tsConfigPath);
      return;
    }

    // If jsconfig.json exists, check if .patchwork is included
    if (fs.existsSync(jsConfigPath)) {
      this.ensureInclude(jsConfigPath);
      return;
    }

    // No config exists — create a minimal jsconfig.json
    const config = {
      compilerOptions: {
        checkJs: true,
        moduleResolution: "bundler",
      },
      include: ["./**/*", ".patchwork/**/*"],
    };
    fs.writeFileSync(jsConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    this.logFn?.(`Created ${jsConfigPath} for automerge import resolution`);
  }

  /**
   * Ensure a tsconfig/jsconfig includes .patchwork in its include array.
   */
  private ensureInclude(configPath: string): void {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const include: string[] = config.include ?? [];
      const patchworkGlob = ".patchwork/**/*";

      if (include.some((p: string) => p.includes(".patchwork"))) return;

      config.include = [...include, patchworkGlob];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      this.logFn?.(`Added .patchwork to include in ${configPath}`);
    } catch (err) {
      this.logFn?.(`Could not update ${configPath}: ${err}`);
    }
  }

  /**
   * Write collected files to a target directory on disk.
   */
  private materializeFiles(
    targetDir: string,
    files: { path: string; content: string }[]
  ): void {
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of files) {
      const filePath = path.join(targetDir, file.path);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, file.content, "utf-8");
    }
  }

  /**
   * Generate or update the ambient module declaration file at
   * <workspace>/.patchwork/patchwork-imports.d.ts.
   *
   * Each resolved import gets a `declare module` block that re-exports
   * from the materialized package directory, respecting subpaths.
   */
  private updateDeclarationFile(
    specifier: string,
    parsed: ParsedSpecifier,
    files: { path: string; content: string }[]
  ): void {
    const patchworkDir = path.join(this.workspaceRoot, ".patchwork");
    fs.mkdirSync(patchworkDir, { recursive: true });
    const declPath = path.join(patchworkDir, "patchwork-imports.d.ts");

    const moduleSpecifier = `/${specifier}`;
    let reExportPath: string;

    if (parsed.subpath) {
      // Direct subpath import — point to the specific file
      reExportPath = `./${parsed.docId}/${parsed.subpath.replace(/\.(js|ts|mjs|mts)$/, "")}`;
    } else {
      // Root import — use package.json entry point if available
      const pkgFile = files.find((f) => f.path === "package.json");
      let mainEntry: string | undefined;
      if (pkgFile) {
        try {
          const pkg = JSON.parse(pkgFile.content);
          mainEntry = pkg.types ?? pkg.typings ?? pkg.main;
        } catch {
          // ignore parse errors
        }
      }

      if (mainEntry) {
        reExportPath = `./${parsed.docId}/${mainEntry.replace(/\.(js|ts|mjs|mts)$/, "")}`;
      } else {
        reExportPath = `./${parsed.docId}`;
      }
    }

    // Check if we can generate typed re-exports or need a fallback
    const hasDts = files.some((f) => f.path.endsWith(".d.ts"));
    const hasReExportTarget = parsed.subpath
      ? files.some((f) => {
          const base = parsed.subpath!.replace(/\.(js|mjs)$/, "");
          return f.path === parsed.subpath || f.path === `${base}.d.ts` || f.path === `${base}.ts`;
        })
      : true;

    let declaration: string;
    if (hasDts || hasReExportTarget) {
      declaration = [
        `declare module "${moduleSpecifier}" {`,
        `  export * from "${reExportPath}";`,
        `  export { default } from "${reExportPath}";`,
        `}`,
      ].join("\n");
    } else {
      declaration = [
        `declare module "${moduleSpecifier}" {`,
        `  const _default: any;`,
        `  export default _default;`,
        `}`,
      ].join("\n");
    }

    // Read existing file and update/append the block for this specifier
    let existing = "";
    if (fs.existsSync(declPath)) {
      existing = fs.readFileSync(declPath, "utf-8");
    }

    // Use the full specifier as block marker so different subpaths
    // of the same doc get their own blocks
    const blockMarkerStart = `// --- ${specifier} ---`;
    const blockMarkerEnd = `// --- /${specifier} ---`;
    const newBlock = `${blockMarkerStart}\n${declaration}\n${blockMarkerEnd}`;

    const startIdx = existing.indexOf(blockMarkerStart);
    const endIdx = existing.indexOf(blockMarkerEnd);

    if (startIdx !== -1 && endIdx !== -1) {
      existing =
        existing.slice(0, startIdx) +
        newBlock +
        existing.slice(endIdx + blockMarkerEnd.length);
    } else {
      existing = existing ? existing.trimEnd() + "\n\n" + newBlock + "\n" : newBlock + "\n";
    }

    fs.writeFileSync(declPath, existing, "utf-8");
  }
}
