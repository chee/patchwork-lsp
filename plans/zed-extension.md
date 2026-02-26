# Zed Extension Plan

Zed extensions are written in Rust (compiled to WASM) and declared via
`extension.toml`. Zed has built-in LSP support, so the main work is packaging
the server and wiring up configuration.

## Directory Structure

```
zed-extension/
├── extension.toml        # Extension manifest
├── src/
│   └── lib.rs            # Extension implementation (Rust → WASM)
├── Cargo.toml            # Rust dependencies (zed_extension_api)
└── languages/
    └── automerge/
        └── config.toml   # Language server association
```

## extension.toml

```toml
[extension]
id = "automerge"
name = "Automerge"
version = "0.1.0"
schema_version = 1
description = "Collaborative editing via Automerge CRDT"

[language_servers.automerge]
language = "Plain Text"
```

## src/lib.rs

Implement the `zed::Extension` trait with two key methods:

- **`language_server_command()`** — returns the command to start the LSP
  server: `node dist/server.cjs --stdio`. The extension needs to resolve
  the path to the installed server bundle.

- **`language_server_install()`** — handles installation. Options:
  1. Run `npm install -g automerge-lsp` (requires publishing to npm first)
  2. Download a prebuilt bundle from a GitHub release
  3. Expect the user to have it installed and configured via settings

## Configuration

Zed passes `initialization_options` from the user's `settings.json`. Users
configure the extension under `"lsp"`:

```json
{
  "lsp": {
    "automerge": {
      "initialization_options": {
        "folderUrl": "automerge:2X...",
        "syncServerUrl": "wss://sync3.automerge.org",
        "debug": false
      }
    }
  }
}
```

## Status Notifications

Zed doesn't expose a status bar API to extensions. The custom
`automerge/status` notification needs a fallback strategy:

- Use `window/showMessage` for important state changes (connected,
  disconnected, errors)
- Use `window/logMessage` for routine status updates (peer count changes)
- Alternatively, adapt the server to also report status via `$/progress`
  tokens, which Zed handles natively

## Workflow

1. User opens the materialized workspace folder (`/tmp/automerge-workspace`
   or a configured path) in Zed
2. Zed activates the extension, starts the LSP server via stdio
3. `initialization_options` flow from `settings.json`
4. Edits sync through the LSP as normal — Zed's incremental text sync
   maps directly to the server's `TextDocumentSyncKind.Incremental`

## Limitations

- **No "Open Automerge Folder" command** — Zed extensions can't add
  arbitrary commands to the command palette. The user must configure
  settings manually and open the workspace directory themselves.
- **No virtual filesystem** — Zed doesn't support custom filesystem
  providers. The existing materialization to disk is the right approach.
- **No status bar widget** — status feedback is limited to LSP-standard
  messages and progress tokens.

## Prerequisites

- Publish the LSP server as an npm package (e.g. `automerge-lsp`) so the
  Zed extension can install it, or provide prebuilt binaries.
- Consider supporting `$/progress` in the server alongside the custom
  `automerge/status` notification for broader editor compatibility.
