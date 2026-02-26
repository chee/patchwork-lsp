# Emacs Package Plan

Emacs has excellent LSP support via eglot (built-in since Emacs 29). The
package is a single Elisp file that registers the server with eglot and
provides interactive commands.

## Directory Structure

```
emacs/
└── automerge-lsp.el      # Complete package in one file
```

## Package Header

```elisp
;;; automerge-lsp.el --- Automerge collaborative editing via LSP -*- lexical-binding: t; -*-

;; Package-Requires: ((emacs "29.1"))
;; Version: 0.1.0
;; URL: https://github.com/chee/automerge-lsp
```

## Core Components

### Custom Variables

```elisp
(defgroup automerge nil
  "Automerge collaborative editing."
  :group 'tools)

(defcustom automerge-lsp-server-command
  '("node" "dist/server.cjs" "--stdio")
  "Command to start the Automerge LSP server."
  :type '(repeat string))

(defcustom automerge-lsp-folder-url nil
  "Automerge document URL for the shared folder."
  :type '(choice (const nil) string))

(defcustom automerge-lsp-sync-server-url
  "wss://sync3.automerge.org"
  "WebSocket URL of the Automerge sync server."
  :type 'string)

(defcustom automerge-lsp-workspace-directory
  "/tmp/automerge-workspace"
  "Local directory where Automerge files are materialized."
  :type 'directory)
```

### Major Mode

Define a derived mode so eglot can be associated with automerge workspace
files specifically, without hijacking all text files:

```elisp
(define-derived-mode automerge-mode text-mode "Automerge"
  "Major mode for files in an Automerge workspace.")

;; Auto-activate for files under the workspace directory
(add-to-list 'auto-mode-alist
  (cons (concat "^" (regexp-quote automerge-lsp-workspace-directory))
        'automerge-mode))
```

### Eglot Registration

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
    `(automerge-mode . ,(lambda (_interactive)
                          `(,@automerge-lsp-server-command
                            :initializationOptions
                            (:folderUrl ,automerge-lsp-folder-url
                             :syncServerUrl ,automerge-lsp-sync-server-url))))))
```

### Status Notification Handler

Handle the custom `automerge/status` notification and display it in the
mode line:

```elisp
(defvar-local automerge-lsp--status nil
  "Current Automerge sync status for mode line display.")

;; Add to mode line
(add-to-list 'mode-line-misc-info
  '(automerge-lsp--status (" [AM:" automerge-lsp--status "]")))

;; Register notification handler with eglot
;; Use cl-defmethod on eglot-handle-notification for
;; the "automerge/status" method to parse the status payload
;; and update automerge-lsp--status in relevant buffers.
```

### Interactive Commands

```elisp
(defun automerge-open-folder (folder-url &optional sync-server-url)
  "Open an Automerge folder by URL.
Prompts for FOLDER-URL and optionally SYNC-SERVER-URL, sets the
configuration, opens the materialized workspace in dired, and
starts eglot."
  (interactive
   (list (read-string "Automerge folder URL: ")
         (read-string "Sync server URL (default: wss://sync3.automerge.org): "
                      nil nil "wss://sync3.automerge.org")))
  ;; Set config, ensure workspace dir exists, open dired, start eglot
  ...)

(defun automerge-status ()
  "Display current Automerge sync status in the minibuffer."
  (interactive)
  (message "Automerge: %s" (or automerge-lsp--status "not connected")))
```

## Alternative: lsp-mode Support

For users who prefer lsp-mode over eglot, provide an optional section or
separate file:

```elisp
(with-eval-after-load 'lsp-mode
  (lsp-register-client
   (make-lsp-client
    :new-connection (lsp-stdio-connection automerge-lsp-server-command)
    :major-modes '(automerge-mode)
    :initialization-options
      (lambda () `(:folderUrl ,automerge-lsp-folder-url
                   :syncServerUrl ,automerge-lsp-sync-server-url))
    :server-id 'automerge-lsp
    :notification-handlers
      (ht ("automerge/status" #'automerge-lsp--handle-status)))))
```

lsp-mode has richer UI (sideline, headerline, modeline) which maps well
to the status notifications.

## Distribution

- Publish to MELPA with the single `automerge-lsp.el` file
- Requires: `emacs >= 29.1` (for built-in eglot)
- The LSP server itself must be installed separately (npm or prebuilt)

## Workflow

1. User installs the Emacs package and the LSP server
2. `M-x automerge-open-folder` prompts for a folder URL and sync server
3. The workspace directory is opened in dired
4. Opening any file in that directory activates `automerge-mode`
5. eglot starts automatically and connects to the LSP server
6. Mode line shows sync status: `[AM: 2 peers]`
7. Edits sync in real time through the LSP ↔ Automerge bridge

## Prerequisites

- Publish the LSP server as an npm package or provide install instructions
- Consider also supporting `$/progress` in the server for native eglot
  progress reporting
