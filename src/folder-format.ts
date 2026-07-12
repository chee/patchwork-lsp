import type { AutomergeUrl } from "@automerge/automerge-repo";

/**
 * A normalized immediate child of a directory document.
 *
 * `name` may contain "/" in the pushwork flat-map format (e.g.
 * "vendor/CellMachine.js"), in which case it denotes a nested path relative to
 * the folder.  `type` is only a hint (present in the "docs array" format); the
 * authoritative file-vs-folder decision is made from the resolved child doc.
 */
export interface DirEntry {
  name: string;
  url: AutomergeUrl; // may be versioned: automerge:<id>#<heads>
  type?: string;
}

// Top-level keys of a directory doc that are metadata, not child entries.
const META_KEYS = new Set(["@patchwork", "lastSyncAt", "with", "name", "title"]);

const BINARY_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "application/octet-stream",
  "application/zip",
  "application/pdf",
];

/** Read the `@patchwork.type` tag ("file" | "directory" | "folder") if present. */
export function patchworkType(doc: any): string | undefined {
  const pw = doc && typeof doc === "object" ? doc["@patchwork"] : undefined;
  return pw && typeof pw === "object" ? pw.type : undefined;
}

export function isFolderish(type: string | undefined): boolean {
  return type === "folder" || type === "application/folder" || type === "directory";
}

export function isBinaryMime(mime: string | undefined): boolean {
  return !!mime && BINARY_PREFIXES.some((p) => mime.startsWith(p));
}

/**
 * Read a file document's `content` as a string.
 *
 * pushwork stores collaborative files as plain strings but "artifact" files as
 * automerge `ImmutableString` (aka RawString) objects — `typeof` is "object",
 * but they stringify to the text.  Binary content (Uint8Array) returns
 * undefined so callers skip it.
 */
export function contentToString(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (content == null) return undefined;
  if (content instanceof Uint8Array) return undefined;
  // automerge ImmutableString / RawString and similar text wrappers
  if (typeof (content as any).toString === "function") {
    const s = (content as any).toString();
    if (typeof s === "string" && s !== "[object Object]") return s;
  }
  return undefined;
}

/** Whether a file document's content is a splice-able collaborative string. */
export function isCollaborativeText(content: unknown): boolean {
  return typeof content === "string";
}

export function isFileDoc(doc: any): boolean {
  if (patchworkType(doc) === "file") return true;
  return typeof doc?.content === "string" || doc?.content instanceof Uint8Array;
}

export function isDirectoryDoc(doc: any): boolean {
  if (!doc || typeof doc !== "object") return false;
  if (isFolderish(patchworkType(doc))) return true;
  if (Array.isArray(doc.docs)) return true;
  // flat-map heuristic: has automerge: url values and no content of its own
  if (typeof doc.content === "undefined") {
    return Object.entries(doc).some(
      ([k, v]) =>
        !META_KEYS.has(k) &&
        typeof v === "string" &&
        (v as string).startsWith("automerge:")
    );
  }
  return false;
}

/**
 * Strip a version/heads suffix so we resolve the *live* collaborative document.
 * pushwork stores "artifact" entries as versioned URLs (`automerge:<id>#<heads>`);
 * the bare id resolves to the same content but stays live for editing.
 */
export function normalizeAutomergeUrl(url: string): AutomergeUrl {
  let cut = -1;
  for (const sep of ["#", "@"]) {
    const i = url.indexOf(sep);
    if (i !== -1) cut = cut === -1 ? i : Math.min(cut, i);
  }
  return (cut === -1 ? url : url.slice(0, cut)) as AutomergeUrl;
}

function isSidecarKey(key: string): boolean {
  return key.startsWith("@") || key.startsWith(".pushwork");
}

/**
 * Normalize any supported directory-document shape into a flat list of its
 * immediate entries.  Supports:
 *
 *   1. "docs array"  — { title, docs: [{ name, type, url }] }        (original)
 *   2. "flat map"    — { "@patchwork": { type: "directory" },        (pushwork)
 *                        "path/to/file.js": "automerge:<id>#<heads>", ... }
 */
export function directoryEntries(doc: any): DirEntry[] {
  if (!doc || typeof doc !== "object") return [];

  if (Array.isArray(doc.docs)) {
    const out: DirEntry[] = [];
    for (const d of doc.docs) {
      if (d && typeof d.url === "string" && typeof d.name === "string") {
        out.push({ name: d.name, url: d.url as AutomergeUrl, type: d.type });
      }
    }
    return out;
  }

  const out: DirEntry[] = [];
  for (const [key, val] of Object.entries(doc)) {
    if (META_KEYS.has(key) || isSidecarKey(key)) continue;
    if (typeof val === "string" && val.startsWith("automerge:")) {
      out.push({ name: key, url: val as AutomergeUrl });
    }
  }
  return out;
}
