import type { Connection } from "vscode-languageserver";
import type { Repo, DocHandle } from "@automerge/vanillajs";
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

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Wire up network event listeners on the Repo to track peer state.
   */
  watchRepo(repo: Repo): void {
    this.repo = repo;
    const net = repo.networkSubsystem;

    net.on("peer", () => {
      this.update({
        state: "connected",
        peerCount: repo.peers.length,
      });
      this.refreshHeads();
    });

    net.on("peer-disconnected", () => {
      const peerCount = repo.peers.length;
      this.update({
        state: peerCount > 0 ? "connected" : "disconnected",
        peerCount,
      });
    });

    // Watch each adapter for close events
    for (const adapter of net.adapters) {
      adapter.on("close", () => {
        this.update({
          state: repo.peers.length > 0 ? "connected" : "disconnected",
          peerCount: repo.peers.length,
        });
      });
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
      state: this.currentStatus.peerCount > 0 ? "connected" : "connecting",
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
