/**
 * Feedback guard prevents didChange events caused by our own
 * workspace/applyEdit from being re-sent to automerge.
 *
 * Before sending an applyEdit, register the expected change.
 * When didChange arrives, check if it matches the FRONT of the
 * expectation queue (strict FIFO). If the front doesn't match,
 * all expectations are discarded as stale.
 */

export interface ExpectedChange {
  offset: number;
  deleteCount: number;
  insertText: string;
}

export class FeedbackGuard {
  private pending: Map<string, ExpectedChange[]> = new Map();

  /**
   * Register an expected change that we're about to push to the editor.
   * `uri` is the document URI.
   */
  expect(uri: string, change: ExpectedChange): void {
    let queue = this.pending.get(uri);
    if (!queue) {
      queue = [];
      this.pending.set(uri, queue);
    }
    queue.push(change);
  }

  /**
   * Check if an incoming didChange matches the next expected change (FIFO).
   * If so, consumes it and returns true (meaning: skip automerge propagation).
   * If not, clears all expectations (they're stale) and returns false.
   */
  consume(uri: string, offset: number, deleteCount: number, insertText: string): boolean {
    const queue = this.pending.get(uri);
    if (!queue || queue.length === 0) return false;

    const front = queue[0];

    if (
      front.offset === offset &&
      front.deleteCount === deleteCount &&
      front.insertText === insertText
    ) {
      queue.shift();
      if (queue.length === 0) {
        this.pending.delete(uri);
      }
      return true;
    }

    // Front doesn't match — expectations are stale, clear them all
    this.pending.delete(uri);
    return false;
  }

  /**
   * Clear all pending expectations for a document.
   */
  clear(uri: string): void {
    this.pending.delete(uri);
  }

  /**
   * Clear all pending expectations.
   */
  clearAll(): void {
    this.pending.clear();
  }

  /**
   * Check if there are pending expectations for a document.
   */
  hasPending(uri: string): boolean {
    const queue = this.pending.get(uri);
    return !!queue && queue.length > 0;
  }

  /**
   * Get count of pending expectations for a document (for debug).
   */
  pendingCount(uri: string): number {
    return this.pending.get(uri)?.length ?? 0;
  }
}
