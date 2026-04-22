# 🌳 pi-tree-ui

A **pi extension** that serves an interactive web-based session tree explorer on `localhost`. Visualize your conversation history, navigate branches, fork sessions, set labels, and compact context — all from the browser.

<p align="center">
  <img src="https://raw.githubusercontent.com/jorgepvenegas/pi-tree-ui/main/screenshot.png" alt="pi-tree-ui screenshot" width="720">
</p>

> **Zero npm dependencies.** Built entirely with Node.js built-ins and vanilla JavaScript.

## Features

- 🔴 **Live updates** — Server-Sent Events push tree changes instantly as you chat
- 🌲 **Visual tree** — Expand/collapse branches, color-coded by role (user, assistant, tool, compaction, label)
- 🧭 **Active path** — The current conversation branch is highlighted with ●
- 🏷 **Labels** — Set or clear labels on any entry directly from the UI
- 🔀 **Fork & navigate** — Queue tree actions (navigate, fork, compact) and execute safely via `/tree-ui-sync`
- 🚫 **Zero build step** — Single self-contained HTML file, no bundler needed
- 🔒 **Localhost only** — Binds to `127.0.0.1`, no authentication required

## Installation

Clone or copy the extension into your pi extensions directory:

```bash
git clone https://github.com/jorgepvenegas/pi-tree-ui.git ~/.pi/agent/extensions/pi-tree-ui
```

Or copy the files manually to `~/.pi/agent/extensions/pi-tree-ui/`:

```
pi-tree-ui/
├── index.ts          # Extension entry point
├── static/
│   └── index.html    # Web UI
└── README.md         # This file
```

## Usage

### Start the server

The server auto-starts when a pi session begins. To start it manually or get the URL:

```
/tree-ui
```

Output:
```
[pi-tree-ui] Server running at http://127.0.0.1:8765
```

Open the URL in your browser.

### Port configuration

Pass the port via CLI flag:

```bash
pi --pi-tree-ui-port 9000
```

Or set an environment variable:

```bash
PI_TREE_UI_PORT=9000 pi
```

If the port is in use, it automatically tries the next 10 ports.

### Web UI actions

| Action | Description |
|--------|-------------|
| **↩ Navigate to here** | Jump to a previous point in the conversation tree |
| **🔀 Fork from here** | Create a new branch starting at this entry |
| **📝 Compact context** | Trigger context compaction |
| **🏷 Set / clear label** | Bookmark an entry with a custom label |
| **📋 Copy entry ID** | Copy the entry UUID to clipboard |

Actions are **queued** in the browser and executed safely in pi via the `/tree-ui-sync` command.

### Sync queued actions

```
/tree-ui-sync
```

This drains the action queue and executes each pending action through pi's `ExtensionCommandContext`.

## Keyboard Shortcuts

The web UI supports standard mouse interaction:

- **Click node** — Select and show details
- **Click ⊟/⊞** — Expand or collapse a branch
- **Expand All / Collapse All** — Sidebar buttons
- **User Only / All** — Filter the tree view

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  pi session │────▶│  pi-tree-ui  │────▶│ HTTP server │
│  (events)   │     │  (state+SSE) │     │ (localhost) │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                 │
                        ┌────────────────────────┘
                        ▼
              ┌─────────────────┐
              │  Browser UI     │
              │  (vanilla JS)   │
              └─────────────────┘
```

### Data flow

1. pi fires lifecycle events (`session_start`, `message_end`, `turn_end`, `session_tree`, etc.)
2. Extension captures `sessionManager` state and builds a `TreeState`
3. Version is incremented and broadcast via SSE to all connected browsers
4. Browser re-fetches `/api/tree` and re-renders
5. Browser POSTs actions to `/api/queue`
6. User runs `/tree-ui-sync` in pi to execute queued actions safely

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve web UI |
| `GET` | `/api/tree` | Full tree state as JSON |
| `GET` | `/api/events` | SSE stream (`{"version": N}`) |
| `POST` | `/api/queue` | Queue an action |
| `GET` | `/api/queue` | List queued actions |
| `DELETE` | `/api/queue` | Clear queue |
| `POST` | `/api/sync` | Trigger `/tree-ui-sync` in pi |
| `POST` | `/api/shutdown` | Stop the HTTP server |

### Action format

```json
{ "action": "navigate", "targetId": "abc-123", "summarize": false }
{ "action": "fork", "targetId": "abc-123", "position": "before" }
{ "action": "label", "targetId": "abc-123", "label": "checkpoint" }
{ "action": "compact", "customInstructions": "Focus on the API design" }
```

## Development

The extension is pure TypeScript with no build step. Edit `index.ts` or `static/index.html` directly and reload pi:

```
/reload
```

### File structure

```
pi-tree-ui/
├── index.ts          # Extension factory, HTTP server, SSE broadcaster
├── static/
│   └── index.html    # Self-contained web UI (CSS + JS inline)
└── README.md
```

### pi Extension API compatibility

Requires `@mariozechner/pi-coding-agent` with the following APIs:

- `pi.registerFlag()` — CLI flag registration
- `pi.registerCommand()` — Slash command registration
- `pi.on()` — Lifecycle event handlers (`session_start`, `message_end`, `turn_end`, `session_tree`, `session_compact`, `session_shutdown`)
- `ctx.navigateTree()` / `ctx.fork()` / `ctx.compact()` — Session manipulation
- `pi.setLabel()` — Entry labeling
- `ctx.sessionManager.getEntries()` / `getLeafId()` / `getLabel()` — Tree state access

## License

MIT © [Jorge Venegas](https://github.com/jorgepvenegas)
