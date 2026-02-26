import { describe, it, expect } from "vitest";
import {
  positionToOffset,
  offsetToPosition,
  lspChangeToSplice,
  applySplice,
  patchToTextEdit,
  patchesToTextEdits,
} from "../src/edit-converter";

describe("positionToOffset", () => {
  it("converts position at start of document", () => {
    expect(positionToOffset("hello\nworld", { line: 0, character: 0 })).toBe(0);
  });

  it("converts position within first line", () => {
    expect(positionToOffset("hello\nworld", { line: 0, character: 3 })).toBe(3);
  });

  it("converts position at start of second line", () => {
    expect(positionToOffset("hello\nworld", { line: 1, character: 0 })).toBe(6);
  });

  it("converts position within second line", () => {
    expect(positionToOffset("hello\nworld", { line: 1, character: 3 })).toBe(9);
  });

  it("handles empty lines", () => {
    expect(positionToOffset("a\n\nb", { line: 2, character: 0 })).toBe(3);
  });

  it("clamps beyond end of line", () => {
    expect(positionToOffset("hi\nthere", { line: 0, character: 100 })).toBe(8);
  });

  it("handles CRLF line endings", () => {
    // \r\n — the \r is a character before \n
    const text = "hello\r\nworld";
    // line 0 is "hello\r", line 1 starts at index 7
    expect(positionToOffset(text, { line: 1, character: 0 })).toBe(7);
  });

  it("handles single line no newline", () => {
    expect(positionToOffset("hello", { line: 0, character: 5 })).toBe(5);
  });

  it("handles empty string", () => {
    expect(positionToOffset("", { line: 0, character: 0 })).toBe(0);
  });
});

describe("offsetToPosition", () => {
  it("converts offset 0", () => {
    expect(offsetToPosition("hello\nworld", 0)).toEqual({
      line: 0,
      character: 0,
    });
  });

  it("converts offset within first line", () => {
    expect(offsetToPosition("hello\nworld", 3)).toEqual({
      line: 0,
      character: 3,
    });
  });

  it("converts offset at newline", () => {
    // offset 5 is the \n character itself — still line 0, char 5
    expect(offsetToPosition("hello\nworld", 5)).toEqual({
      line: 0,
      character: 5,
    });
  });

  it("converts offset at start of second line", () => {
    expect(offsetToPosition("hello\nworld", 6)).toEqual({
      line: 1,
      character: 0,
    });
  });

  it("converts offset within second line", () => {
    expect(offsetToPosition("hello\nworld", 9)).toEqual({
      line: 1,
      character: 3,
    });
  });

  it("handles empty string", () => {
    expect(offsetToPosition("", 0)).toEqual({ line: 0, character: 0 });
  });

  it("clamps negative offset", () => {
    expect(offsetToPosition("hello", -5)).toEqual({ line: 0, character: 0 });
  });
});

describe("positionToOffset and offsetToPosition roundtrip", () => {
  const text = "first line\nsecond line\n\nfourth line";

  it("roundtrips through various positions", () => {
    const positions = [
      { line: 0, character: 0 },
      { line: 0, character: 5 },
      { line: 1, character: 0 },
      { line: 1, character: 6 },
      { line: 2, character: 0 },
      { line: 3, character: 0 },
      { line: 3, character: 6 },
    ];

    for (const pos of positions) {
      const offset = positionToOffset(text, pos);
      const roundtripped = offsetToPosition(text, offset);
      expect(roundtripped).toEqual(pos);
    }
  });
});

describe("lspChangeToSplice", () => {
  it("converts a simple insertion", () => {
    const text = "hello world";
    const splice = lspChangeToSplice(
      text,
      { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
      ","
    );
    expect(splice).toEqual({
      path: ["content"],
      offset: 5,
      deleteCount: 0,
      insertText: ",",
    });
  });

  it("converts a deletion", () => {
    const text = "hello world";
    const splice = lspChangeToSplice(
      text,
      { start: { line: 0, character: 5 }, end: { line: 0, character: 6 } },
      ""
    );
    expect(splice).toEqual({
      path: ["content"],
      offset: 5,
      deleteCount: 1,
      insertText: "",
    });
  });

  it("converts a replacement", () => {
    const text = "hello world";
    const splice = lspChangeToSplice(
      text,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      "goodbye"
    );
    expect(splice).toEqual({
      path: ["content"],
      offset: 0,
      deleteCount: 5,
      insertText: "goodbye",
    });
  });

  it("converts a multi-line deletion", () => {
    const text = "line one\nline two\nline three";
    const splice = lspChangeToSplice(
      text,
      { start: { line: 0, character: 4 }, end: { line: 1, character: 4 } },
      ""
    );
    // offset 4 to offset 13 (start of "line two" + 4)
    expect(splice.offset).toBe(4);
    expect(splice.deleteCount).toBe(9); // " one\nline"
  });

  it("converts newline insertion", () => {
    const text = "hello world";
    const splice = lspChangeToSplice(
      text,
      { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
      "\n"
    );
    expect(splice).toEqual({
      path: ["content"],
      offset: 5,
      deleteCount: 0,
      insertText: "\n",
    });
  });
});

describe("applySplice", () => {
  it("inserts text", () => {
    expect(applySplice("hello world", 5, 0, ",")).toBe("hello, world");
  });

  it("deletes text", () => {
    expect(applySplice("hello world", 5, 1, "")).toBe("helloworld");
  });

  it("replaces text", () => {
    expect(applySplice("hello world", 0, 5, "goodbye")).toBe("goodbye world");
  });
});

describe("patchToTextEdit", () => {
  it("converts a splice (insert) patch", () => {
    const text = "hello world";
    const edit = patchToTextEdit(text, {
      action: "splice",
      path: ["content", 5],
      value: ", beautiful",
    });
    expect(edit).toEqual({
      range: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 5 },
      },
      newText: ", beautiful",
    });
  });

  it("converts a del patch", () => {
    const text = "hello world";
    const edit = patchToTextEdit(text, {
      action: "del",
      path: ["content", 5],
      length: 6,
    });
    expect(edit).toEqual({
      range: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 11 },
      },
      newText: "",
    });
  });

  it("ignores non-content patches", () => {
    const edit = patchToTextEdit("hello", {
      action: "splice",
      path: ["name", 0],
      value: "x",
    });
    expect(edit).toBeNull();
  });

  it("converts a splice across lines", () => {
    const text = "line one\nline two";
    const edit = patchToTextEdit(text, {
      action: "splice",
      path: ["content", 8],
      value: "\ninserted\n",
    });
    expect(edit).toEqual({
      range: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 8 },
      },
      newText: "\ninserted\n",
    });
  });
});

describe("patchesToTextEdits", () => {
  it("processes multiple patches sequentially", () => {
    const text = "hello world";
    const { edits, finalText } = patchesToTextEdits(text, [
      { action: "del", path: ["content", 5], length: 1 },
      { action: "splice", path: ["content", 5], value: ", " },
    ]);
    expect(edits).toHaveLength(2);
    expect(finalText).toBe("hello, world");
  });

  it("handles insert then delete", () => {
    const text = "abcd";
    const { finalText } = patchesToTextEdits(text, [
      { action: "splice", path: ["content", 2], value: "XY" },
      { action: "del", path: ["content", 0], length: 1 },
    ]);
    expect(finalText).toBe("bXYcd");
  });
});
