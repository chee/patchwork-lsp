import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { AutomergeFsProvider } from "./automerge-fs-provider.js";

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let fsProvider: AutomergeFsProvider | undefined;
let currentContext: vscode.ExtensionContext | undefined;
let currentWorkspaceRoot: string | undefined;
let currentFolderUrl: string | undefined;
let currentSyncServerUrl: string | undefined;
let currentDebug: boolean | undefined;
let currentMode: "vfs" | "fallback" | undefined;

const DEFAULT_SYNC_SERVER = "wss://sync3.automerge.org";

interface AutomergeStatus {
  state: "connecting" | "connected" | "syncing" | "disconnected" | "error";
  peerCount: number;
  fileCount: number;
  message?: string;
  heads?: string[];
  inSync?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
  currentContext = context;

  // Register FileSystemProvider for the automerge: scheme
  fsProvider = new AutomergeFsProvider(() => client);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("automerge", fsProvider, {
      isCaseSensitive: true,
      isReadonly: false,
    })
  );

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  statusBarItem.command = "automerge.showStatus";
  context.subscriptions.push(statusBarItem);

  // Register show status command
  const showStatusCmd = vscode.commands.registerCommand(
    "automerge.showStatus",
    () => {
      if (!client) {
        vscode.window.showInformationMessage("PatchworkFS is not running.");
        return;
      }
      const text = statusBarItem?.tooltip;
      if (text) {
        vscode.window.showInformationMessage(`PatchworkFS: ${text}`);
      }
    }
  );
  context.subscriptions.push(showStatusCmd);

  // Register restart command
  const restartCmd = vscode.commands.registerCommand(
    "automerge.restart",
    async () => {
      if (currentContext && currentFolderUrl && currentSyncServerUrl) {
        vscode.window.showInformationMessage("PatchworkFS: Restarting...");
        await startClient(
          currentContext,
          currentFolderUrl,
          currentSyncServerUrl,
          currentDebug,
          currentMode ?? "fallback",
          currentWorkspaceRoot
        );
        vscode.window.showInformationMessage("PatchworkFS: Restarted.");
      } else {
        vscode.window.showWarningMessage(
          "PatchworkFS: No active session to restart. Use 'PatchworkFS: Open Folder' first."
        );
      }
    }
  );
  context.subscriptions.push(restartCmd);

  const openFolderCmd = vscode.commands.registerCommand(
    "automerge.openFolder",
    async () => {
      const folderUrl = await vscode.window.showInputBox({
        prompt: "Automerge Folder URL",
        placeHolder: "automerge:2X...",
        title: "Open Automerge Folder",
      });

      if (!folderUrl) return;

      const syncServerUrl = await vscode.window.showInputBox({
        prompt: "Sync Server URL",
        placeHolder: DEFAULT_SYNC_SERVER,
        value: DEFAULT_SYNC_SERVER,
        title: "Automerge Sync Server",
      });

      if (syncServerUrl === undefined) return;

      // Store folder URL and sync server in globalState for persistence
      context.globalState.update("automerge.folderUrl", folderUrl);
      context.globalState.update("automerge.syncServerUrl", syncServerUrl || DEFAULT_SYNC_SERVER);

      // Extract the doc ID from the folder URL (strip automerge: prefix if present)
      const rootDocId = folderUrl.startsWith("automerge:")
        ? folderUrl.slice("automerge:".length)
        : folderUrl;

      // Open as virtual workspace.
      // Use path-based format: automerge:/<docId>/ — NOT authority-based,
      // because VS Code lowercases the authority component per RFC 3986,
      // which mangles case-sensitive Automerge doc IDs.
      const wsUri = vscode.Uri.from({ scheme: "automerge", path: `/${rootDocId}/` });
      vscode.workspace.updateWorkspaceFolders(0, 0, {
        uri: wsUri,
        name: `PatchworkFS: ${rootDocId.slice(0, 8)}...`,
      });

      // Start the LSP client in VFS mode
      await startClient(
        context,
        folderUrl,
        syncServerUrl || DEFAULT_SYNC_SERVER,
        undefined,
        "vfs"
      );
    }
  );

  context.subscriptions.push(openFolderCmd);

  // Check for automerge: scheme workspace folders (VFS mode auto-start)
  const automergeFolder = vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.scheme === "automerge"
  );

  if (automergeFolder) {
    // Recover folderUrl from globalState, or reconstruct from URI path
    // URI format: automerge:/<docId>/  →  path = /<docId>/
    const storedFolderUrl = context.globalState.get<string>("automerge.folderUrl");
    const folderUrl = storedFolderUrl || `automerge:${extractDocId(automergeFolder.uri)}`;
    const syncServerUrl =
      (context.globalState.get<string>("automerge.syncServerUrl")) ||
      DEFAULT_SYNC_SERVER;

    startClient(context, folderUrl, syncServerUrl, undefined, "vfs");
    return;
  }

  // Fallback: auto-start if we detect automerge config in workspace settings (disk mode)
  const config = vscode.workspace.getConfiguration("automerge");
  const folderUrl = config.get<string>("folderUrl");

  if (folderUrl && vscode.workspace.workspaceFolders?.[0]) {
    const syncServerUrl = config.get<string>("syncServerUrl") || DEFAULT_SYNC_SERVER;
    const debug = config.get<boolean>("debug");
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    startClient(context, folderUrl, syncServerUrl, debug, "fallback", workspaceRoot);
  }
}

function updateStatusBar(status: AutomergeStatus): void {
  if (!statusBarItem) return;

  let icon: string;
  let label: string;

  switch (status.state) {
    case "connecting":
      icon = "$(loading~spin)";
      label = "Connecting";
      break;
    case "connected":
      icon = "$(cloud)";
      label = `${status.peerCount} peer${status.peerCount !== 1 ? "s" : ""}`;
      break;
    case "syncing":
      icon = "$(sync~spin)";
      label = "Syncing";
      break;
    case "disconnected":
      icon = "$(cloud-offline)";
      label = "Disconnected";
      break;
    case "error":
      icon = "$(error)";
      label = "Error";
      break;
  }

  statusBarItem.text = `${icon} PatchworkFS: ${label}`;

  // Build tooltip
  const lines: string[] = [];
  lines.push(`State: ${status.state}`);
  lines.push(`Peers: ${status.peerCount}`);
  lines.push(`Files: ${status.fileCount}`);
  if (status.heads && status.heads.length > 0) {
    lines.push(`Heads: ${status.heads.join(", ")}`);
    lines.push(`In sync: ${status.inSync ? "yes" : "no"}`);
  }
  if (status.message) {
    lines.push(`Message: ${status.message}`);
  }
  statusBarItem.tooltip = lines.join("\n");

  // Color based on state
  if (status.state === "error") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (status.state === "disconnected") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }

  statusBarItem.show();
}

async function startClient(
  context: vscode.ExtensionContext,
  folderUrl: string,
  syncServerUrl: string,
  debug?: boolean,
  mode: "vfs" | "fallback" = "fallback",
  workspaceRoot?: string
): Promise<void> {
  // Store for restart
  currentFolderUrl = folderUrl;
  currentSyncServerUrl = syncServerUrl;
  currentDebug = debug;
  currentMode = mode;
  currentWorkspaceRoot = workspaceRoot;

  if (client) {
    await client.stop();
    client = undefined;
  }

  // Show initial connecting state
  updateStatusBar({
    state: "connecting",
    peerCount: 0,
    fileCount: 0,
  });

  // Look for server.cjs: first next to the bundled extension (published),
  // then in the parent package's dist (development)
  const bundledServer = path.join(__dirname, "server.cjs");
  const devServer = path.resolve(__dirname, "..", "..", "dist", "server.cjs");
  const serverPath = fs.existsSync(bundledServer) ? bundledServer : devServer;

  const serverOptions: ServerOptions = {
    command: "node",
    args: [serverPath, "--stdio"],
  };

  // Build document selector based on mode
  const documentSelector: LanguageClientOptions["documentSelector"] = [];
  if (mode === "vfs") {
    documentSelector.push({ scheme: "automerge" });
  }
  if (workspaceRoot) {
    documentSelector.push({ scheme: "file", pattern: `${workspaceRoot}/**` });
  }
  // Always include both schemes so the server can handle either
  if (!documentSelector.some((s) => "scheme" in s && s.scheme === "automerge")) {
    documentSelector.push({ scheme: "automerge" });
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector,
    initializationOptions: {
      folderUrl,
      syncServerUrl,
      debug,
      mode,
    },
    ...(workspaceRoot
      ? {
          workspaceFolder: {
            uri: vscode.Uri.file(workspaceRoot),
            name: path.basename(workspaceRoot),
            index: 0,
          },
        }
      : {}),
  };

  client = new LanguageClient(
    "patchworkfs",
    "PatchworkFS",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client);
  await client.start();

  // Listen for status notifications from the server
  client.onNotification("automerge/status", (status: AutomergeStatus) => {
    updateStatusBar(status);
  });

  // Listen for file change notifications from the server → forward to FileSystemProvider
  client.onNotification(
    "automerge/fileChanged",
    (params: { type: "changed" | "created" | "deleted"; path: string }) => {
      if (!fsProvider) return;

      // Find automerge: workspace folder to construct URI
      const automergeFolder = vscode.workspace.workspaceFolders?.find(
        (f) => f.uri.scheme === "automerge"
      );
      if (!automergeFolder) return;

      const rootDocId = extractDocId(automergeFolder.uri);
      const uri = vscode.Uri.from({
        scheme: "automerge",
        path: `/${rootDocId}/${params.path}`,
      });

      let changeType: vscode.FileChangeType;
      switch (params.type) {
        case "created":
          changeType = vscode.FileChangeType.Created;
          break;
        case "deleted":
          changeType = vscode.FileChangeType.Deleted;
          break;
        default:
          changeType = vscode.FileChangeType.Changed;
          break;
      }

      fsProvider.fireChange([{ type: changeType, uri }]);
    }
  );
}

/**
 * Extract the Automerge doc ID from a workspace URI.
 * Path-based: automerge:/<docId>/  →  first path segment
 * Authority-based (legacy): automerge://<docId>/  →  authority
 */
function extractDocId(uri: vscode.Uri): string {
  if (uri.authority) return uri.authority;
  const segments = uri.path.split("/").filter(Boolean);
  return segments[0] || "";
}

export async function deactivate(): Promise<void> {
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }
  if (client) {
    await client.stop();
    client = undefined;
  }
}
