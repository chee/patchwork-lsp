import {
  Position,
  Range,
  TextEdit,
} from "vscode-languageserver-protocol";

/**
 * Convert an LSP (line, character) position to an absolute character offset
 * within the given text.
 */
export function positionToOffset(text: string, position: Position): number {
  let offset = 0;
  let line = 0;

  while (line < position.line) {
    const idx = text.indexOf("\n", offset);
    if (idx === -1) {
      // Position is beyond the last line — clamp to end
      return text.length;
    }
    offset = idx + 1;
    line++;
  }

  return Math.min(offset + position.character, text.length);
}

/**
 * Convert an absolute character offset to an LSP (line, character) position.
 */
export function offsetToPosition(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;

  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, character: clamped - lineStart };
}

/**
 * Describes a splice operation on an automerge text field.
 */
export interface SpliceOp {
  path: string[];
  offset: number;
  deleteCount: number;
  insertText: string;
}

/**
 * Convert an LSP incremental content change to an automerge splice operation.
 *
 * `currentText` is the document text BEFORE this change is applied.
 */
export function lspChangeToSplice(
  currentText: string,
  range: Range,
  newText: string
): SpliceOp {
  const startOffset = positionToOffset(currentText, range.start);
  const endOffset = positionToOffset(currentText, range.end);

  return {
    path: ["content"],
    offset: startOffset,
    deleteCount: endOffset - startOffset,
    insertText: newText,
  };
}

/**
 * Apply a splice to text and return the new text. Useful for keeping
 * a mirror of the document in sync.
 */
export function applySplice(
  text: string,
  offset: number,
  deleteCount: number,
  insertText: string
): string {
  return text.slice(0, offset) + insertText + text.slice(offset + deleteCount);
}

/**
 * An automerge patch on a text field. We handle "splice" (insert) and "del".
 */
export interface AutomergePatch {
  action: "splice" | "del" | "put" | "insert";
  path: (string | number)[];
  value?: string;
  length?: number;
}

/**
 * Convert an automerge text patch to an LSP TextEdit.
 *
 * `currentText` is the document text BEFORE the patch is applied.
 */
export function patchToTextEdit(
  currentText: string,
  patch: AutomergePatch
): TextEdit | null {
  if (patch.path[0] !== "content") return null;

  const charIndex = patch.path[1] as number;

  if (patch.action === "splice") {
    // Insert text at charIndex
    const pos = offsetToPosition(currentText, charIndex);
    return {
      range: { start: pos, end: pos },
      newText: patch.value ?? "",
    };
  }

  if (patch.action === "del") {
    // Delete `length` characters starting at charIndex
    const deleteCount = patch.length ?? 1;
    const start = offsetToPosition(currentText, charIndex);
    const end = offsetToPosition(currentText, charIndex + deleteCount);
    return {
      range: { start, end },
      newText: "",
    };
  }

  return null;
}

/**
 * Process multiple automerge patches into LSP TextEdits.
 * Patches are applied sequentially, updating `currentText` as we go
 * so that offsets remain correct for subsequent patches.
 *
 * Returns the edits and the final text after all patches.
 */
export function patchesToTextEdits(
  currentText: string,
  patches: AutomergePatch[]
): { edits: TextEdit[]; finalText: string } {
  const edits: TextEdit[] = [];
  let text = currentText;

  for (const patch of patches) {
    const edit = patchToTextEdit(text, patch);
    if (edit) {
      edits.push(edit);
      // Apply the edit to our mirror text
      const offset = positionToOffset(text, edit.range.start);
      const endOffset = positionToOffset(text, edit.range.end);
      text = applySplice(text, offset, endOffset - offset, edit.newText);
    }
  }

  return { edits, finalText: text };
}
