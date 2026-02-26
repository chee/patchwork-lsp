import { describe, it, expect, beforeEach } from "vitest";
import { FeedbackGuard } from "../src/feedback-guard";

describe("FeedbackGuard", () => {
  let guard: FeedbackGuard;

  beforeEach(() => {
    guard = new FeedbackGuard();
  });

  it("consumes a matching expected change", () => {
    guard.expect("file:///test.md", {
      offset: 5,
      deleteCount: 0,
      insertText: "hello",
    });

    const consumed = guard.consume("file:///test.md", 5, 0, "hello");
    expect(consumed).toBe(true);
  });

  it("does not consume a non-matching change", () => {
    guard.expect("file:///test.md", {
      offset: 5,
      deleteCount: 0,
      insertText: "hello",
    });

    const consumed = guard.consume("file:///test.md", 5, 0, "world");
    expect(consumed).toBe(false);
  });

  it("does not consume from wrong URI", () => {
    guard.expect("file:///test.md", {
      offset: 5,
      deleteCount: 0,
      insertText: "hello",
    });

    const consumed = guard.consume("file:///other.md", 5, 0, "hello");
    expect(consumed).toBe(false);
  });

  it("returns false when no expectations", () => {
    const consumed = guard.consume("file:///test.md", 0, 0, "x");
    expect(consumed).toBe(false);
  });

  it("consumes expectations in FIFO order", () => {
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "a" });
    guard.expect("file:///test.md", { offset: 5, deleteCount: 0, insertText: "b" });

    // Must consume in order — first one first
    expect(guard.consume("file:///test.md", 0, 0, "a")).toBe(true);
    expect(guard.consume("file:///test.md", 5, 0, "b")).toBe(true);
    expect(guard.hasPending("file:///test.md")).toBe(false);
  });

  it("discards stale expectations when front doesn't match", () => {
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "a" });
    guard.expect("file:///test.md", { offset: 5, deleteCount: 0, insertText: "b" });

    // Try to consume the second one first — doesn't match front, clears all
    expect(guard.consume("file:///test.md", 5, 0, "b")).toBe(false);
    // All expectations cleared
    expect(guard.hasPending("file:///test.md")).toBe(false);
    expect(guard.consume("file:///test.md", 0, 0, "a")).toBe(false);
  });

  it("each expectation can only be consumed once", () => {
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "x" });

    expect(guard.consume("file:///test.md", 0, 0, "x")).toBe(true);
    expect(guard.consume("file:///test.md", 0, 0, "x")).toBe(false);
  });

  it("handles multiple identical expectations", () => {
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "x" });
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "x" });

    expect(guard.consume("file:///test.md", 0, 0, "x")).toBe(true);
    expect(guard.consume("file:///test.md", 0, 0, "x")).toBe(true);
    expect(guard.consume("file:///test.md", 0, 0, "x")).toBe(false);
  });

  it("clear removes all expectations for a URI", () => {
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "a" });
    guard.expect("file:///test.md", { offset: 5, deleteCount: 0, insertText: "b" });
    guard.clear("file:///test.md");

    expect(guard.consume("file:///test.md", 0, 0, "a")).toBe(false);
    expect(guard.hasPending("file:///test.md")).toBe(false);
  });

  it("clearAll removes everything", () => {
    guard.expect("file:///a.md", { offset: 0, deleteCount: 0, insertText: "x" });
    guard.expect("file:///b.md", { offset: 0, deleteCount: 0, insertText: "y" });
    guard.clearAll();

    expect(guard.hasPending("file:///a.md")).toBe(false);
    expect(guard.hasPending("file:///b.md")).toBe(false);
  });

  it("matches on deleteCount", () => {
    guard.expect("file:///test.md", { offset: 5, deleteCount: 3, insertText: "" });

    // Wrong deleteCount — clears expectations
    expect(guard.consume("file:///test.md", 5, 0, "")).toBe(false);
    // Expectation already cleared
    expect(guard.consume("file:///test.md", 5, 3, "")).toBe(false);
  });

  it("non-matching change clears stale expectations so local edits pass through", () => {
    guard.expect("file:///test.md", { offset: 0, deleteCount: 0, insertText: "R1" });
    guard.expect("file:///test.md", { offset: 5, deleteCount: 0, insertText: "R2" });

    // Local edit arrives — doesn't match front, clears all expectations
    expect(guard.consume("file:///test.md", 10, 0, "LOCAL")).toBe(false);
    // Expectations are now cleared
    expect(guard.hasPending("file:///test.md")).toBe(false);
  });
});
