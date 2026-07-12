// Standalone checks for folder-format.ts (run: node scripts/check-folder-format.ts)
import {
  directoryEntries,
  normalizeAutomergeUrl,
  contentToString,
  isDirectoryDoc,
  isFileDoc,
  isFolderish,
  isBinaryMime,
  isCollaborativeText,
} from "../src/folder-format.ts";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log("  ok:", label);
  else { fails++; console.log(`  FAIL: ${label}\n    got:  ${g}\n    want: ${w}`); }
}

// --- pushwork flat-map directory (the real shape) ---
const flat = {
  "@patchwork": { title: "knitoutjs", type: "directory" },
  lastSyncAt: 1783349589768,
  ".pushworkattributes": "automerge:qq2wtXgB2M8tEjptwh5WyMf7Tq1",
  "index.js": "automerge:b999S4Bk7P4cf51B1CZxuKbxGur#2CXWqNgzhhpt65K3uURTv97Prz",
  "package.json": "automerge:32nPMpjjqZxcwN7igw5wGGZ3rMtu",
  "vendor/evalJS.js": "automerge:36z9WkSH2RWd61cUcVBP1rDLakzV#BJKKcULQPNknFf",
};
const flatEntries = directoryEntries(flat);
eq("flat: entry count (meta + sidecar skipped)", flatEntries.length, 3);
eq("flat: nested path kept as name", flatEntries.map(e => e.name).sort(),
   ["index.js", "package.json", "vendor/evalJS.js"]);
eq("flat: sidecar .pushworkattributes skipped",
   flatEntries.some(e => e.name === ".pushworkattributes"), false);
eq("flat: isDirectoryDoc", isDirectoryDoc(flat), true);

// --- docs-array directory (original shape) ---
const arr = {
  title: "t",
  docs: [
    { name: "a.ts", type: "text", url: "automerge:AAA" },
    { name: "sub", type: "folder", url: "automerge:BBB" },
    { name: "pic.png", type: "image/png", url: "automerge:CCC" },
  ],
};
const arrEntries = directoryEntries(arr);
eq("array: entry count", arrEntries.length, 3);
eq("array: folder hint preserved", arrEntries[1].type, "folder");
eq("array: isDirectoryDoc", isDirectoryDoc(arr), true);

// --- file doc ---
const fileDoc = { "@patchwork": { type: "file" }, content: "hi", extension: "ts", mimeType: "application/typescript", name: "a.ts" };
eq("file: isFileDoc", isFileDoc(fileDoc), true);
eq("file: isDirectoryDoc", isDirectoryDoc(fileDoc), false);
eq("file: directoryEntries empty", directoryEntries(fileDoc).length, 0);

// --- url normalization (strip #heads / @version) ---
eq("url: strip #heads", normalizeAutomergeUrl("automerge:ABC#deadbeef"), "automerge:ABC");
eq("url: strip @version", normalizeAutomergeUrl("automerge:ABC@v1"), "automerge:ABC");
eq("url: bare unchanged", normalizeAutomergeUrl("automerge:ABC"), "automerge:ABC");

// --- content coercion ---
class ImmutableString { s: string; constructor(s: string) { this.s = s; } toString() { return this.s; } }
eq("content: plain string", contentToString("hello"), "hello");
eq("content: ImmutableString -> text", contentToString(new ImmutableString("art")), "art");
eq("content: Uint8Array -> undefined (binary)", contentToString(new Uint8Array([1, 2, 3])), undefined);
eq("content: plain object -> undefined", contentToString({ a: 1 }), undefined);
eq("content: null -> undefined", contentToString(null), undefined);
eq("collab: plain string is collaborative", isCollaborativeText("x"), true);
eq("collab: ImmutableString is NOT collaborative", isCollaborativeText(new ImmutableString("x")), false);

// --- helpers ---
eq("isFolderish directory", isFolderish("directory"), true);
eq("isFolderish folder", isFolderish("folder"), true);
eq("isFolderish text", isFolderish("text"), false);
eq("isBinaryMime image", isBinaryMime("image/png"), true);
eq("isBinaryMime js", isBinaryMime("application/javascript"), false);

console.log(fails ? `\nFAILED: ${fails}` : "\nALL FOLDER-FORMAT CHECKS PASSED");
process.exit(fails ? 1 : 0);
