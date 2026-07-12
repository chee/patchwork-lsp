import type { Connection } from "vscode-languageserver";
import type { Repo, DocHandle } from "@automerge/automerge-repo";
import type { UnixFileEntry } from "./types.js";

export interface AutomergeStatus {
  state: "connecting" | "connected" | "syncing" | "disconnected" | "error";
  peerCount: number;
  fileCount: number;
  message?: string;
  /** Short hex prefix of the local document heads (first tracked doc) */
  heads?: string[];
  /** Whether local heads match the last known remote heads */
  inSync?: boolean;
}

const STATUS_METHOD = "automerge/status";

/**
 * Sends automerge status notifications to the LSP client.
 * Hooks into Repo network events to track connection state.
 */
export class StatusNotifier {
  private connection: Connection;
  private repo: Repo | undefined;
  private trackedHandles: Map<string, DocHandle<UnixFileEntry>> = new Map();
  private currentStatus: AutomergeStatus = {
    state: "connecting",
    peerCount: 0,
    fileCount: 0,
  };
  private hasEverConnected = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Wire up connection-state tracking on the Repo.
   *
   * Subduction does NOT use automerge-repo's standard networkSubsystem
   * adapters/`peer` events — it has its own transport, so `repo.peers` stays
   * empty and `net.on("peer")` never fires even while docs sync fine.  We poll
   * subduction's own `isSubductionConnected()` / `connectedSubductionPeerIds()`
   * instead, and keep the classic listeners as a fallback for standard repos.
   */
  watchRepo(repo: Repo): void {
    this.repo = repo;
    const net = repo.networkSubsystem;

    net.on("peer", () => {
      this.pollSubduction();
      this.refreshHeads();
    });
    net.on("peer-disconnected", () => this.pollSubduction());
    for (const adapter of net.adapters) {
      adapter.on("close", () => this.pollSubduction());
    }

    // Subduction has no connection events, so poll its state.
    this.pollTimer = setInterval(() => this.pollSubduction(), 1500);
    // Don't keep the process alive just for polling.
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
    this.pollSubduction();
  }

  /** Whether we're connected to a subduction sync server. */
  private subductionConnected(): boolean {
    const r = this.repo as any;
    if (r && typeof r.isSubductionConnected === "function") {
      try {
        return !!r.isSubductionConnected();
      } catch {
        return false;
      }
    }
    // Fallback for a standard (non-subduction) repo.
    return (this.repo?.peers?.length ?? 0) > 0;
  }

  /** Number of connected collaborator peers (excludes the sync server itself). */
  private subductionPeerCount(): number {
    const r = this.repo as any;
    if (r && typeof r.connectedSubductionPeerIds === "function") {
      try {
        const ids = r.connectedSubductionPeerIds();
        if (Array.isArray(ids)) return ids.length;
        if (ids && typeof ids === "object") return Object.keys(ids).length;
      } catch {
        /* fall through */
      }
    }
    return this.repo?.peers?.length ?? 0;
  }

  /** Reconcile status with subduction's actual connection state. */
  private pollSubduction(): void {
    const connected = this.subductionConnected();
    const peerCount = this.subductionPeerCount();
    if (connected) this.hasEverConnected = true;

    let state = this.currentStatus.state;
    if (state !== "syncing" && state !== "error") {
      state = connected
        ? "connected"
        : this.hasEverConnected
          ? "disconnected"
          : "connecting";
    }

    if (state !== this.currentStatus.state || peerCount !== this.currentStatus.peerCount) {
      this.update({ state, peerCount });
    }
  }

  /** Stop polling. */
  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Track a document handle so we can report its heads.
   */
  trackDocument(uri: string, handle: DocHandle<UnixFileEntry>): void {
    this.trackedHandles.set(uri, handle);
  }

  /**
   * Stop tracking a document handle.
   */
  untrackDocument(uri: string): void {
    this.trackedHandles.delete(uri);
  }

  /**
   * Report that initial file loading is complete.
   */
  filesLoaded(count: number): void {
    this.update({
      state: this.subductionConnected() ? "connected" : this.currentStatus.state,
      fileCount: count,
    });
  }

  /**
   * Report that a sync operation happened (remote patch received).
   */
  syncing(): void {
    this.update({ state: "syncing" });
    this.refreshHeads();
    // Reset back to connected after a brief moment
    setTimeout(() => {
      if (this.currentStatus.state === "syncing") {
        this.update({ state: "connected" });
      }
    }, 800);
  }

  /**
   * Report an error state.
   */
  error(message: string): void {
    this.update({ state: "error", message });
  }

  /**
   * Check heads of tracked documents and whether they match remote heads.
   */
  refreshHeads(): void {
    if (!this.repo || this.trackedHandles.size === 0) return;

    // Use the first tracked document to report heads
    const [, handle] = this.trackedHandles.entries().next().value!;
    try {
      if (!handle.isReady()) return;
      const localHeads = handle.heads();
      // Truncate heads to short prefixes for display
      const shortHeads = localHeads.map((h: string) => h.slice(0, 8));

      // Check sync state against all peers
      let inSync = true;
      const peers = this.repo.peers;
      if (peers.length === 0) {
        inSync = false;
      }
      for (const peerId of peers) {
        const storageId = this.repo.getStorageIdOfPeer(peerId);
        if (!storageId) {
          inSync = false;
          break;
        }
        const syncInfo = handle.getSyncInfo(storageId);
        if (!syncInfo) {
          inSync = false;
          break;
        }
        // Compare heads arrays
        const remoteHeads = syncInfo.lastHeads;
        if (
          localHeads.length !== remoteHeads.length ||
          !localHeads.every((h: string, i: number) => h === remoteHeads[i])
        ) {
          inSync = false;
          break;
        }
      }

      this.update({ heads: shortHeads, inSync });
    } catch {
      // Document may not be ready yet
    }
  }

  /**
   * Send a partial status update to the client.
   */
  private update(partial: Partial<AutomergeStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...partial };
    this.connection.sendNotification(STATUS_METHOD, this.currentStatus);
  }
}
