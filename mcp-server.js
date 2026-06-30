#!/usr/bin/env node
/* ============================================================
   Skill Sync — MCP server (Model Context Protocol)
   Exposes Skill Sync as TOOLS an AI client (e.g. Claude Desktop)
   can call: read a room, send chat, list topics, fetch a quiz.

   Dependency-free: speaks JSON-RPC 2.0 over stdio (newline-
   delimited), the MCP stdio transport — no SDK, no cloud API.
   It drives the local Skill Sync HTTP server (default :4321),
   which must be running for the room/chat tools to work.

   Register in an MCP client (e.g. Claude Desktop config):
     "skill-sync": { "command": "node", "args": ["C:\\Cluade AI\\Skill Sync\\mcp-server.js"] }
   ============================================================ */
const { QUESTION_BANK } = require("./questions.js");
const BASE = process.env.SKILLSYNC_URL || "http://localhost:4321";

/* ---------- Tool definitions ---------- */
const TOOLS = [
  {
    name: "list_topics",
    description: "List the topics available in Skill Sync.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_quiz",
    description: "Get the 10-mark certification quiz questions for a topic (without the answers).",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string", description: "Topic name, e.g. Python" } },
      required: ["topic"], additionalProperties: false,
    },
  },
  {
    name: "get_room_state",
    description: "Get the live state of a Skill Sync room: the teacher/learner profiles, chat, and media.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string", description: "Room code, e.g. DEMO-1" } },
      required: ["room"], additionalProperties: false,
    },
  },
  {
    name: "send_chat",
    description: "Post a chat message into a Skill Sync room.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room code" },
        name: { type: "string", description: "Display name of the sender" },
        text: { type: "string", description: "Message text" },
      },
      required: ["room", "text"], additionalProperties: false,
    },
  },
];

/* ---------- Tool implementations ---------- */
async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case "list_topics":
      return Object.keys(QUESTION_BANK).join("\n");

    case "get_quiz": {
      const bank = QUESTION_BANK[args.topic];
      if (!bank) return `Unknown topic "${args.topic}". Available: ${Object.keys(QUESTION_BANK).join(", ")}`;
      return bank.map((q, i) => `Q${i + 1}. ${q.q}\n   ${q.options.map((o, n) => `${n + 1}) ${o}`).join("  ")}`).join("\n");
    }

    case "get_room_state": {
      const r = await fetch(`${BASE}/api/state?room=${encodeURIComponent(args.room)}`);
      const s = await r.json();
      const who = ["teacher", "learner"].map(role => s.profiles[role] ? `${role}: ${s.profiles[role].name}` : `${role}: (empty)`).join(", ");
      const chat = (s.chat || []).map(m => `[${m.t}] ${m.name || m.from}: ${m.text}`).join("\n") || "(no messages)";
      return `Room ${args.room}\n${who}\n\nChat:\n${chat}`;
    }

    case "send_chat": {
      const msg = { from: "mcp", name: args.name || "Assistant", text: args.text, t: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
      await fetch(`${BASE}/api/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: args.room, action: { type: "chat", msg } }),
      });
      return `Sent to room ${args.room}: "${args.text}"`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ---------- JSON-RPC 2.0 over stdio ---------- */
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) get no response.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "skill-sync", version: "2.0.0" },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments);
      return reply(id, { content: [{ type: "text", text: String(text) }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true });
    }
  }
  return fail(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
const queue = [];
let processing = false;
async function drain() {
  if (processing) return;
  processing = true;
  while (queue.length) { try { await handle(queue.shift()); } catch {} }
  processing = false;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    queue.push(msg);
  }
  drain();
});
process.stderr.write(`Skill Sync MCP server ready (talking to ${BASE})\n`);
