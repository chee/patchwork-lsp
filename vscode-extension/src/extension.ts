import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

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
  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  statusBarItem.command = "automerge.showStatus";
  context.subscriptions.push(statusBarItem);

  // Register show status command (shows detailed info)
  const showStatusCmd = vscode.commands.registerCommand(
    "automerge.showStatus",
    () => {
      if (!client) {
        vscode.window.showInformationMessage("Automerge LSP is not running.");
        return;
      }
      // The status bar tooltip already shows details; this is a fallback
      const text = statusBarItem?.tooltip;
      if (text) {
        vscode.window.showInformationMessage(`Automerge: ${text}`);
      }
    }
  );
  context.subscriptions.push(showStatusCmd);

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

      // Create a workspace directory for this folder
      const workspaceDir = path.join(
        os.tmpdir(),
        "automerge-lsp",
        folderUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)
      );
      fs.mkdirSync(workspaceDir, { recursive: true });

      // Write settings so the extension auto-starts after folder opens
      const vscodeDir = path.join(workspaceDir, ".vscode");
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(
        path.join(vscodeDir, "settings.json"),
        JSON.stringify(
          {
            "automerge.folderUrl": folderUrl,
            "automerge.syncServerUrl": syncServerUrl || DEFAULT_SYNC_SERVER,
          },
          null,
          2
        )
      );

      // Open the workspace folder — this reloads the window,
      // so the extension will re-activate and pick up the settings
      const uri = vscode.Uri.file(workspaceDir);
      await vscode.commands.executeCommand("vscode.openFolder", uri);
    }
  );

  context.subscriptions.push(openFolderCmd);

  // Auto-start if we detect automerge config in workspace settings
  const config = vscode.workspace.getConfiguration("automerge");
  const folderUrl = config.get<string>("folderUrl");

  if (folderUrl && vscode.workspace.workspaceFolders?.[0]) {
    const syncServerUrl = config.get<string>("syncServerUrl") || DEFAULT_SYNC_SERVER;
    const debug = config.get<boolean>("debug");
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    startClient(context, workspaceRoot, folderUrl, syncServerUrl, debug);
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

  statusBarItem.text = `${icon} Automerge: ${label}`;

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
  workspaceRoot: string,
  folderUrl: string,
  syncServerUrl: string,
  debug?: boolean
): Promise<void> {
  if (client) {
    await client.stop();
  }

  // Show initial connecting state
  updateStatusBar({
    state: "connecting",
    peerCount: 0,
    fileCount: 0,
  });

  // The server is the compiled server.cjs from the parent package
  const serverModule = context.asAbsolutePath(path.join("..", "dist", "server.cjs"));

  // If running in dev, the server might be at a different location
  const serverPath = fs.existsSync(serverModule)
    ? serverModule
    : path.resolve(__dirname, "..", "..", "dist", "server.cjs");

  const serverOptions: ServerOptions = {
    command: "node",
    args: [serverPath, "--stdio"],
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", pattern: `${workspaceRoot}/**` }],
    initializationOptions: {
      folderUrl,
      syncServerUrl,
      debug,
    },
    workspaceFolder: {
      uri: vscode.Uri.file(workspaceRoot),
      name: path.basename(workspaceRoot),
      index: 0,
    },
  };

  client = new LanguageClient(
    "automerge-lsp",
    "Automerge LSP",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client);
  await client.start();

  // Listen for status notifications from the server
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
