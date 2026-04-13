#!/usr/bin/env node
// ── ClashControl Smart Bridge — MCP Transport ─────────────────────
// Exposes ClashControl actions as MCP tools so Claude Desktop/Code
// can control the app directly. Part of the Smart Bridge — the LLM
// bridge that connects different AI assistants to ClashControl.
// Communicates with the browser via WebSocket on localhost:19802.
//
// Usage:
//   npx @clashcontrol/mcp-server          # or: node index.js
//
// Claude Desktop config (~/.claude/claude_desktop_config.json):
//   { "mcpServers": { "clashcontrol": { "command": "npx", "args": ["@clashcontrol/mcp-server"] } } }

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const WebSocket = require('ws');

const { TOOLS, MCP_INSTRUCTIONS, registerMcpTools, registerMcpResources, registerMcpPrompts } = require('./tools.js');

const VERSION = require('./package.json').version;
const WS_PORT = 19802;
const REQUEST_TIMEOUT = 15000; // 15s for browser to respond

// ── WebSocket bridge to browser ───────────────────────────────────

let wss = null;
let browserSocket = null;
let pendingRequests = new Map(); // id → {resolve, reject, timer}
let requestId = 0;

function startWsBridge() {
  wss = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    browserSocket = ws;
    process.stderr.write('[Smart Bridge MCP] Browser connected\n');
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const req = pendingRequests.get(msg.id);
          clearTimeout(req.timer);
          pendingRequests.delete(msg.id);
          req.resolve(msg.result);
        }
      } catch (e) {
        process.stderr.write('[Smart Bridge MCP] Bad message: ' + e.message + '\n');
      }
    });
    ws.on('close', () => {
      browserSocket = null;
      process.stderr.write('[Smart Bridge MCP] Browser disconnected\n');
    });
  });
  wss.on('error', (err) => {
    process.stderr.write('[Smart Bridge MCP] WebSocket error: ' + err.message + '\n');
  });
}

function sendToBrowser(action, params) {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('ClashControl is not connected. Open clashcontrol.io and enable the Smart Bridge addon in Navigator → Addons.'));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Request timed out — ClashControl did not respond within ' + (REQUEST_TIMEOUT / 1000) + 's'));
    }, REQUEST_TIMEOUT);
    pendingRequests.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, action, params: params || {} }));
  });
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({ name: 'ClashControl', version: VERSION }, { instructions: MCP_INSTRUCTIONS });

registerMcpTools(server, z, sendToBrowser);
registerMcpResources(server, sendToBrowser);
registerMcpPrompts(server, z);

// ── Start ─────────────────────────────────────────────────────────

async function main() {
  startWsBridge();
  process.stderr.write('[Smart Bridge MCP] WebSocket bridge on ws://127.0.0.1:' + WS_PORT + '\n');
  process.stderr.write('[Smart Bridge MCP] Waiting for Claude to connect via stdio...\n');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[Smart Bridge MCP] Connected to Claude\n');
}

main().catch((e) => {
  process.stderr.write('[Smart Bridge MCP] Fatal: ' + e.message + '\n');
  process.exit(1);
});
