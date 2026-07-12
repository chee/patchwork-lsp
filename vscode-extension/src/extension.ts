import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  DocumentFilter,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

const DEFAULT_SYNC_SERVER = "wss://subduction.sync.inkandswitch.com";

interface AutomergeStatus {
  state: "connecting" | "connected" | "syncing" | "disconnected" | "error";
  peerCount: number;
  fileCount: number;
  message?: string;
  heads?: string[];
  inSync?: boolean;
}

function cacheDir(docId: string): string {
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "patchwork-lsp", "docs", docId);
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(xdgCache, "patchwork-lsp", "docs", docId);
}

function extractDocId(folderUrl: string): string {
  return folderUrl.startsWith("automerge:") ? folderUrl.slice("automerge:".length) : folderUrl;
}

export function activate(context: vscode.ExtensionContext) {
  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = "automerge.showStatus";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("automerge.showStatus", () => {
      if (!client) {
        vscode.window.showInformationMessage("PatchworkFS is not running.");
        return;
      }
      if (statusBarItem?.tooltip) {
        vscode.window.showInformationMessage(`PatchworkFS: ${statusBarItem.tooltip}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("automerge.restart", async () => {
      const folderUrl = context.globalState.get<string>("automerge.folderUrl");
      const syncServerUrl = context.globalState.get<string>("automerge.syncServerUrl") || DEFAULT_SYNC_SERVER;
      if (folderUrl) {
        vscode.window.showInformationMessage("PatchworkFS: Restarting...");
        await startClient(context, folderUrl, syncServerUrl);
        vscode.window.showInformationMessage("PatchworkFS: Restarted.");
      } else {
        vscode.window.showWarningMessage(
          "PatchworkFS: No active session to restart. Use 'PatchworkFS: Open Folder' first."
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("automerge.openFolder", async () => {
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

      const server = syncServerUrl || DEFAULT_SYNC_SERVER;

      context.globalState.update("automerge.folderUrl", folderUrl);
      context.globalState.update("automerge.syncServerUrl", server);

      const docId = extractDocId(folderUrl);
      const workspaceRoot = cacheDir(docId);
      fs.mkdirSync(workspaceRoot, { recursive: true });

      await startClient(context, folderUrl, server, workspaceRoot);

      // Open the cache dir as a regular workspace folder
      const wsUri = vscode.Uri.file(workspaceRoot);
      vscode.workspace.updateWorkspaceFolders(0, 0, {
        uri: wsUri,
        name: `PatchworkFS: ${docId.slice(0, 8)}...`,
      });
    })
  );

  // Always start the LSP — import resolution works even without a folder URL
  const config = vscode.workspace.getConfiguration("automerge");
  const folderUrl = config.get<string>("folderUrl");
  const syncServerUrl = config.get<string>("syncServerUrl") || DEFAULT_SYNC_SERVER;
  const debug = config.get<boolean>("debug");
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  startClient(context, folderUrl, syncServerUrl, workspaceRoot, debug);
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

  const lines: string[] = [];
  lines.push(`State: ${status.state}`);
  lines.push(`Peers: ${status.peerCount}`);
  lines.push(`Files: ${status.fileCount}`);
  if (status.heads?.length) {
    lines.push(`Heads: ${status.heads.join(", ")}`);
    lines.push(`In sync: ${status.inSync ? "yes" : "no"}`);
  }
  if (status.message) {
    lines.push(`Message: ${status.message}`);
  }
  statusBarItem.tooltip = lines.join("\n");

  if (status.state === "error") {
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (status.state === "disconnected") {
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBarItem.backgroundColor = undefined;
  }

  statusBarItem.show();
}

async function startClient(
  context: vscode.ExtensionContext,
  folderUrl: string | undefined,
  syncServerUrl: string,
  workspaceRoot?: string,
  debug?: boolean,
): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }

  updateStatusBar({ state: "connecting", peerCount: 0, fileCount: 0 });

  const bundledServer = path.join(__dirname, "server.cjs");
  const devServer = path.resolve(__dirname, "..", "..", "dist", "server.cjs");
  const serverPath = fs.existsSync(bundledServer) ? bundledServer : devServer;

  const serverOptions: ServerOptions = {
    command: "node",
    args: [serverPath, "--stdio"],
  };

  const documentSelector: DocumentFilter[] = [];
  if (workspaceRoot) {
    documentSelector.push({ scheme: "file", pattern: `${workspaceRoot}/**` });
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector,
    initializationOptions: {
      folderUrl,
      syncServerUrl,
      debug,
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

  client = new LanguageClient("patchworkfs", "PatchworkFS", serverOptions, clientOptions);
  context.subscriptions.push(client);
  await client.start();

  client.onNotification("automerge/status", (status: AutomergeStatus) => {
    updateStatusBar(status);
  });
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
