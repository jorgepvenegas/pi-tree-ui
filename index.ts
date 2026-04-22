import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveStaticHtml(): string {
  const candidates = [
    join(__dirname, "static", "index.html"),
    join(process.cwd(), "agent", "extensions", "pi-tree-ui", "static", "index.html"),
    join(homedir(), ".pi", "agent", "extensions", "pi-tree-ui", "static", "index.html"),
  ];

  for (const candidate of candidates) {
    try {
      const html = readFileSync(candidate, "utf8");
      console.log(`[pi-tree-ui] Serving static HTML from: ${candidate}`);
      return html;
    } catch (err) {
      console.log(`[pi-tree-ui] Static file not found at: ${candidate}`);
    }
  }

  throw new Error(
    `Could not find static/index.html. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}

interface TreeNode {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  customType?: string;
  content: string;
  timestamp: string;
  model?: string;
  label?: string;
  children: string[];
}

interface TreeState {
  version: number;
  leafId: string | null;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  nodes: TreeNode[];
}

type QueuedAction =
  | { action: "navigate"; targetId: string; summarize?: boolean; customInstructions?: string }
  | { action: "fork"; targetId: string; position?: "before" | "at" }
  | { action: "label"; targetId: string; label?: string }
  | { action: "compact"; customInstructions?: string };

let treeState: TreeState = {
  version: 0,
  leafId: null,
  sessionFile: undefined,
  sessionName: undefined,
  nodes: [],
};

let pendingAction: QueuedAction | null = null;
const sseClients: Set<ServerResponse> = new Set();
let server: ReturnType<typeof createServer> | null = null;
let globalCtx: ExtensionContext | null = null;
let globalPi: ExtensionAPI | null = null;

async function executeAction(
  action: QueuedAction,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<string[]> {
  const results: string[] = [];
  try {
    switch (action.action) {
      case "navigate": {
        const result = await ctx.navigateTree(action.targetId, {
          summarize: action.summarize ?? false,
          customInstructions: action.customInstructions,
        });
        if (result.cancelled) {
          results.push(`navigate ${action.targetId}: cancelled`);
        } else {
          results.push(`navigate ${action.targetId}: ok`);
        }
        break;
      }
      case "fork": {
        const result = await ctx.fork(action.targetId, {
          position: action.position ?? "before",
        });
        if (result.cancelled) {
          results.push(`fork ${action.targetId}: cancelled`);
        } else {
          results.push(`fork ${action.targetId}: ok`);
        }
        break;
      }
      case "label": {
        pi.setLabel(action.targetId, action.label);
        results.push(`label ${action.targetId}: ${action.label ?? "cleared"}`);
        break;
      }
      case "compact": {
        ctx.compact({
          customInstructions: action.customInstructions,
          onComplete: () => {
            ctx.ui.notify("Compaction complete", "success");
          },
          onError: (err) => {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          },
        });
        results.push("compact: queued");
        break;
      }
      default: {
        results.push(`unknown action: ${(action as any).action}`);
        break;
      }
    }
  } catch (err) {
    results.push(`${action.action}: error - ${(err as Error).message}`);
    console.error(`[pi-tree-ui] Error processing action:`, err);
  }
  return results;
}

function broadcastVersion(version: number) {
  const data = `data: ${JSON.stringify({ version })}\n\n`;
  for (const res of sseClients) {
    res.write(data);
  }
}

function updateTreeState(ctx: ExtensionContext) {
  const sm = ctx.sessionManager;
  const entries = sm.getEntries();
  const leafId = sm.getLeafId();
  const sessionFile = sm.getSessionFile();
  const sessionName = sm.getSessionName();

  const nodeMap = new Map<string, TreeNode>();

  for (const entry of entries) {
    let content = "";
    let role: string | undefined;
    let model: string | undefined;
    let customType: string | undefined;

    if (entry.type === "message") {
      const msg = entry.message;
      role = msg.role;
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join(" ");
      }
      if (msg.role === "assistant") {
        model = `${msg.provider}/${msg.model}`;
      }
    } else if (entry.type === "compaction") {
      content = `[compaction: ${entry.tokensBefore} tokens] ${entry.summary.slice(0, 80)}`;
    } else if (entry.type === "branch_summary") {
      content = `[branch summary] ${entry.summary.slice(0, 80)}`;
    } else if (entry.type === "custom") {
      customType = entry.customType;
      content = `[custom: ${entry.customType}] ${JSON.stringify(entry.data).slice(0, 80)}`;
    } else if (entry.type === "custom_message") {
      customType = entry.customType;
      content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
    } else if (entry.type === "label") {
      content = `[label: ${entry.label ?? "(cleared)"}] on ${entry.targetId}`;
    } else if (entry.type === "model_change") {
      content = `[model change] ${entry.provider}/${entry.modelId}`;
    } else if (entry.type === "thinking_level_change") {
      content = `[thinking level] ${entry.thinkingLevel}`;
    } else if (entry.type === "session_info") {
      content = `[session name] ${entry.name ?? ""}`;
    }

    nodeMap.set(entry.id, {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      role,
      customType,
      content: content.slice(0, 120),
      timestamp: entry.timestamp,
      model,
      label: sm.getLabel(entry.id),
      children: [],
    });
  }

  // Build children arrays
  for (const node of nodeMap.values()) {
    if (node.parentId && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId)!.children.push(node.id);
    }
  }

  // Sort children by timestamp
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => {
      const na = nodeMap.get(a)!;
      const nb = nodeMap.get(b)!;
      return new Date(na.timestamp).getTime() - new Date(nb.timestamp).getTime();
    });
  }

  treeState = {
    version: treeState.version + 1,
    leafId,
    sessionFile,
    sessionName,
    nodes: Array.from(nodeMap.values()),
  };

  broadcastVersion(treeState.version);
}

function startServer(port: number) {
  if (server) return;

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === "/" && method === "GET") {
      try {
        const html = resolveStaticHtml();
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch (err) {
        console.error(`[pi-tree-ui] Failed to serve UI:`, (err as Error).message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Failed to load UI\n\n${(err as Error).message}`);
      }
      return;
    }

    if (url === "/api/tree" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(treeState));
      return;
    }

    if (url === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ version: treeState.version })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url === "/api/queue" && method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const action = JSON.parse(body) as QueuedAction;
          if (!action.action) throw new Error("Missing action field");
          const validActions = ["navigate", "fork", "label", "compact"];
          if (!validActions.includes(action.action)) {
            throw new Error(`Invalid action: ${action.action}. Must be one of: ${validActions.join(", ")}`);
          }
          pendingAction = action;
          console.log(`[pi-tree-ui] Action set: ${action.action}`);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queued: true, action: action.action }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }

    if (url === "/api/queue" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pendingAction));
      return;
    }

    if (url === "/api/queue" && method === "DELETE") {
      pendingAction = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cleared: true }));
      return;
    }

    if (url === "/api/sync" && method === "POST") {
      try {
        if (!pendingAction) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No pending action" }));
          return;
        }
        if (!globalCtx) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Extension context not available. Run /tree-ui first." }));
          return;
        }
        const action = pendingAction;
        pendingAction = null;
        const results = await executeAction(action, globalCtx as ExtensionCommandContext, globalPi!);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ executed: true, action: action.action, results }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (url === "/api/shutdown" && method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ stopped: true }));
      stopServer();
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  let currentPort = port;
  let remainingAttempts = 10;

  const onError = (err: any) => {
    if (err.code === "EADDRINUSE" && remainingAttempts > 0) {
      currentPort++;
      remainingAttempts--;
      console.log(`[pi-tree-ui] Port ${currentPort - 1} in use, trying ${currentPort}`);
      server!.listen(currentPort, "127.0.0.1");
    } else {
      console.error(`[pi-tree-ui] Failed to start server:`, err.message);
      server!.off("error", onError);
      server = null;
    }
  };

  server.once("listening", () => {
    console.log(`[pi-tree-ui] Server running at http://127.0.0.1:${currentPort}`);
    server!.off("error", onError);
  });

  server.on("error", onError);
  server.listen(currentPort, "127.0.0.1");
}

function stopServer() {
  for (const res of sseClients) {
    res.end();
  }
  sseClients.clear();
  if (server) {
    server.close(() => {
      console.log("[pi-tree-ui] Server stopped");
    });
    server = null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("pi-tree-ui-port", {
    description: "Port for the pi-tree-ui HTTP server",
    type: "string",
    default: "8765",
  });

  const port = parseInt(process.env.PI_TREE_UI_PORT ?? "", 10) || parseInt((pi.getFlag("pi-tree-ui-port") as string | undefined) ?? "8765", 10);

  pi.registerCommand("tree-ui", {
    description: "Start the pi-tree-ui server and print the UI URL",
    handler: async (_args, ctx) => {
      globalPi = pi;
      globalCtx = ctx;
      startServer(port);
      // Wait briefly for server to bind so we can report actual port
      await new Promise((r) => setTimeout(r, 100));
      const actualPort = server ? (server.address() as any)?.port ?? port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      ctx.ui.notify(`pi-tree-ui: ${url}`, "info");
      console.log(`[pi-tree-ui] ${url}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    globalPi = pi;
    globalCtx = ctx;
    updateTreeState(ctx);
    startServer(port);
  });

  pi.on("message_start", async (_event, ctx) => {
    updateTreeState(ctx);
  });

  pi.on("message_end", async (_event, ctx) => {
    updateTreeState(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateTreeState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateTreeState(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    updateTreeState(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopServer();
  });
}
