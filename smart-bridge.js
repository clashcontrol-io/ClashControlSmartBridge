#!/usr/bin/env node
// ── ClashControl Smart Bridge ─────────────────────────────────────
// Single binary that runs everything:
//   - WebSocket bridge to the browser (port 19802)
//   - REST API for ChatGPT / any LLM (port 19803)
//   - MCP server for Claude Desktop/Code (stdio, when --mcp flag is used)
//
// Usage:
//   ./clashcontrol-smart-bridge            # REST + WebSocket (default)
//   ./clashcontrol-smart-bridge --mcp      # MCP + WebSocket (for Claude Desktop)
//
// Claude Desktop config:
//   { "mcpServers": { "clashcontrol": {
//       "command": "/path/to/clashcontrol-smart-bridge", "args": ["--mcp"]
//   } } }

const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = require('./package.json').version;
const WS_PORT = 19802;
const REST_PORT = parseInt(process.env.PORT, 10) || 19803;
const REQUEST_TIMEOUT = 15000;
const MCP_MODE = process.argv.includes('--mcp');

// ── Self-installer ────────────────────────────────────────────────
// When running as a compiled binary (pkg), copy to a permanent location
// on first launch so the downloaded installer file can be deleted.

function getInstallPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const name = 'clashcontrol-smart-bridge' + ext;
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || os.homedir(), 'ClashControl', name);
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'ClashControl', name);
  return path.join(os.homedir(), '.local', 'share', 'clashcontrol', name);
}

function selfInstall() {
  // Only applies to compiled pkg binaries, not `node smart-bridge.js`
  if (!process.pkg) return;

  const src = process.execPath;
  const dest = getInstallPath();

  // Already running from the install location — nothing to do
  if (path.normalize(src) === path.normalize(dest)) return;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);

    process.stdout.write('[Smart Bridge] Installed to: ' + dest + '\n');
    process.stdout.write('[Smart Bridge] You can now delete the downloaded file from your Downloads folder.\n');
    process.stdout.write('[Smart Bridge] Relaunching...\n\n');

    const child = spawn(dest, process.argv.slice(2), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    process.exit(0);
  } catch (e) {
    process.stdout.write('[Smart Bridge] Could not install to ' + dest + ': ' + e.message + ' — running from current location.\n');
  }
}

// ── Auto-configure Claude Desktop ────────────────────────────────
// On first run, add ClashControl to Claude Desktop's MCP config
// so the user never needs to edit JSON manually.

function getClaudeConfigPath() {
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || os.homedir(), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function configureClaude() {
  const configPath = getClaudeConfigPath();

  // Determine the right command + args for Claude Desktop to spawn us
  let command, args;
  if (process.pkg) {
    // Running as compiled binary — use the installed binary path directly
    command = getInstallPath();
    args = ['--mcp'];
  } else {
    // Running via node — use node + absolute path to this script
    command = process.execPath;
    args = [path.resolve(__dirname, 'smart-bridge.js'), '--mcp'];
  }

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    // File doesn't exist or isn't valid JSON — we'll create it
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Already configured with the same command — skip
  if (config.mcpServers.clashcontrol) {
    const existing = config.mcpServers.clashcontrol;
    if (existing.command === command) return;
  }

  // Add or update the clashcontrol entry
  config.mcpServers.clashcontrol = { command, args };

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    log('Claude Desktop configured: ' + configPath);
    log('Restart Claude Desktop to activate ClashControl tools.');
  } catch (e) {
    log('Could not configure Claude Desktop: ' + e.message);
  }
}

// ── Auto-updater ──────────────────────────────────────────────────
// Only active when running as a compiled pkg binary.

function getAssetName() {
  if (process.platform === 'win32') return 'clashcontrol-smart-bridge-win.exe';
  if (process.platform === 'darwin') return 'clashcontrol-smart-bridge-macos';
  return 'clashcontrol-smart-bridge-linux';
}

function isNewerVersion(latest, current) {
  const [lMaj, lMin, lPat] = latest.split('.').map(Number);
  const [cMaj, cMin, cPat] = current.split('.').map(Number);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'clashcontrol-smart-bridge/' + VERSION } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { follow(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

let pendingUpdate = null; // { version, url, downloadUrl } when a newer release exists

function notifyBrowser(msg) {
  if (browserSocket && browserSocket.readyState === WebSocket.OPEN)
    browserSocket.send(JSON.stringify(msg));
}

async function checkAndUpdate() {
  if (!process.pkg) return; // only for compiled binaries

  // Clean up leftover .old file from previous update (Windows)
  try { fs.unlinkSync(process.execPath + '.old'); } catch (e) {}

  let release;
  try {
    release = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'api.github.com',
        path: '/repos/clashcontrol-io/ClashControlSmartBridge/releases/latest',
        headers: { 'User-Agent': 'clashcontrol-smart-bridge/' + VERSION }
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  } catch (e) { return; } // silently skip if offline

  const latest = (release.tag_name || '').replace(/^v/, '');
  if (!latest || !isNewerVersion(latest, VERSION)) return;

  const asset = (release.assets || []).find(a => a.name === getAssetName());
  if (!asset) { log('Update asset not found: ' + getAssetName()); return; }

  // Cache the available update for GET /update
  pendingUpdate = { version: latest, url: release.html_url, downloadUrl: asset.browser_download_url };
  log('Update available: v' + latest);
}

async function applyUpdate() {
  if (!pendingUpdate) return;
  const { version, downloadUrl } = pendingUpdate;

  log('Downloading update v' + version + '...');
  notifyBrowser({ type: 'update_downloading', version });

  const tmpPath = process.execPath + '.tmp';
  try {
    await downloadFile(downloadUrl, tmpPath);
    if (process.platform !== 'win32') fs.chmodSync(tmpPath, 0o755);

    // Windows: rename running exe to .old (can't delete while running), place new binary
    // Unix: overwrite directly (OS holds old inode in memory until process exits)
    if (process.platform === 'win32') fs.renameSync(process.execPath, process.execPath + '.old');
    fs.renameSync(tmpPath, process.execPath);

    log('Updated to v' + version + ' — relaunching...');
    notifyBrowser({ type: 'update_installed', version });

    setTimeout(() => {
      const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      process.exit(0);
    }, 500); // brief delay so the browser receives the notification
  } catch (e) {
    log('Auto-update failed: ' + e.message);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ── WebSocket bridge to browser ───────────────────────────────────

let wss = null;
let browserSocket = null;
let pendingRequests = new Map();
let requestId = 0;

function startWsBridge() {
  wss = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    browserSocket = ws;
    log('Browser connected via WebSocket');
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
        log('Bad WS message: ' + e.message);
      }
    });
    ws.on('close', () => {
      browserSocket = null;
      log('Browser disconnected');
    });
  });
  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WebSocket port ' + WS_PORT + ' in use — connecting as client');
      connectWsAsClient();
    } else {
      log('WebSocket error: ' + err.message);
    }
  });
}

function connectWsAsClient() {
  const ws = new WebSocket('ws://127.0.0.1:' + WS_PORT);
  ws.on('open', () => { browserSocket = ws; log('Connected to existing WebSocket bridge'); });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id != null && pendingRequests.has(msg.id)) {
        const req = pendingRequests.get(msg.id);
        clearTimeout(req.timer);
        pendingRequests.delete(msg.id);
        req.resolve(msg.result);
      }
    } catch (e) {}
  });
  ws.on('close', () => { browserSocket = null; setTimeout(connectWsAsClient, 5000); });
  ws.on('error', () => {});
}

function sendToBrowser(action, params) {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('ClashControl is not connected. Open clashcontrol.io and enable the Smart Bridge addon.'));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Request timed out'));
    }, REQUEST_TIMEOUT);
    pendingRequests.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, action, params: params || {} }));
  });
}

// Logging helper — MCP mode writes to stderr (stdout is for MCP protocol)
function log(msg) {
  const line = '[Smart Bridge] ' + msg + '\n';
  if (MCP_MODE) process.stderr.write(line);
  else process.stdout.write(line);
}

// ── Tool definitions (shared by REST and MCP) ─────────────────────
const { TOOLS, MCP_INSTRUCTIONS, registerMcpTools, registerMcpResources, registerMcpPrompts } = require('./tools.js');

// ── REST API ──────────────────────────────────────────────────────

function generateOpenAPISpec() {
  const paths = {};
  paths['/status'] = { get: { operationId: 'getStatus', summary: 'Bridge and browser connection status', responses: { '200': { description: 'Status', content: { 'application/json': { schema: { type: 'object' } } } } } } };
  paths['/tools'] = { get: { operationId: 'listTools', summary: 'List available tools', responses: { '200': { description: 'Tools', content: { 'application/json': { schema: { type: 'object' } } } } } } };

  for (const [name, tool] of Object.entries(TOOLS)) {
    const properties = {}; const required = [];
    for (const [pn, pd] of Object.entries(tool.params)) {
      properties[pn] = { type: pd.t || 'string' };
      if (pd.e) properties[pn].enum = pd.e;
      if (pd.d) properties[pn].description = pd.d;
      if (pd.r) required.push(pn);
    }
    paths['/call/' + name] = { post: {
      operationId: name, summary: tool.desc,
      ...(Object.keys(properties).length > 0 ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } } } } : {}),
      responses: { '200': { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } }, '502': { description: 'Browser not connected' }, '504': { description: 'Timed out' } }
    } };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'ClashControl Smart Bridge', description: 'LLM bridge — control ClashControl BIM clash detection from Claude, ChatGPT, or any AI assistant.', version: '0.1.0' },
    servers: [{ url: 'http://localhost:' + REST_PORT }],
    paths
  };
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') { resolve({}); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}

function startRestServer() {
  const srv = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const json = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    if (path === '/status' && req.method === 'GET') {
      json(200, { bridge: 'running', browser: browserSocket && browserSocket.readyState === WebSocket.OPEN ? 'connected' : 'disconnected', wsPort: WS_PORT, tools: Object.keys(TOOLS).length, mcp: MCP_MODE });
      return;
    }
    if (path === '/tools' && req.method === 'GET') { json(200, { tools: TOOLS }); return; }
    if (path === '/openapi.json' && req.method === 'GET') { json(200, generateOpenAPISpec()); return; }

    if (path === '/update' && req.method === 'GET') {
      if (pendingUpdate) json(200, { update_available: true, version: pendingUpdate.version, url: pendingUpdate.url });
      else json(200, { update_available: false });
      return;
    }
    if (path === '/update' && req.method === 'POST') {
      if (!pendingUpdate) { json(200, { update_available: false }); return; }
      json(200, { ok: true });
      applyUpdate();
      return;
    }

    const m = path.match(/^\/call\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      if (!TOOLS[m[1]]) { json(404, { error: 'Unknown tool: ' + m[1] }); return; }
      const params = await parseBody(req);
      try { const result = await sendToBrowser(m[1], params); json(200, { result }); }
      catch (e) { json(e.message.includes('not connected') ? 502 : 504, { error: e.message }); }
      return;
    }

    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>ClashControl Smart Bridge</title></head>
<body style="font-family:system-ui;max-width:700px;margin:2rem auto;padding:0 1rem;color:#e2e8f0;background:#0f172a">
<h1 style="color:#f59e0b">ClashControl Smart Bridge</h1>
<p>LLM bridge — connect Claude, ChatGPT, or any AI assistant to control ClashControl.</p>
<h3>Endpoints</h3>
<ul><li><code>GET /status</code></li><li><code>GET /tools</code></li><li><code>POST /call/{action}</code></li><li><code>GET /openapi.json</code> (ChatGPT Actions)</li></ul>
<h3>Setup</h3>
<p><b>ChatGPT:</b> Create custom GPT → Actions → Import URL → <code>http://localhost:${REST_PORT}/openapi.json</code></p>
<p><b>Claude Desktop:</b> Run with <code>--mcp</code> flag and add to Claude Desktop config</p>
<p><b>Any LLM:</b> POST to <code>/call/{tool}</code> with JSON body</p>
<p style="color:#94a3b8;font-size:0.85rem">Browser: <span id="s">checking...</span></p>
<script>fetch('/status').then(r=>r.json()).then(d=>{document.getElementById('s').textContent=d.browser;document.getElementById('s').style.color=d.browser==='connected'?'#22c55e':'#ef4444'})</script>
</body></html>`);
      return;
    }
    json(404, { error: 'Not found' });
  });

  srv.listen(REST_PORT, '127.0.0.1', () => {
    log('REST API:  http://127.0.0.1:' + REST_PORT);
    log('OpenAPI:   http://127.0.0.1:' + REST_PORT + '/openapi.json');
  });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') log('REST port ' + REST_PORT + ' in use — another instance is already running.');
    else log('REST server error: ' + err.message);
  });
}

// ── MCP Server (Claude Desktop) ──────────────────────────────────

async function startMcpServer() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const mcp = new McpServer({ name: 'ClashControl', version: VERSION }, { instructions: MCP_INSTRUCTIONS });

  registerMcpTools(mcp, z, sendToBrowser);
  registerMcpResources(mcp, sendToBrowser);
  registerMcpPrompts(mcp, z);

  log('MCP server starting on stdio...');
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP connected to Claude');
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  selfInstall();
  configureClaude();
  checkAndUpdate();

  startWsBridge();
  log('WebSocket:  ws://127.0.0.1:' + WS_PORT);

  // Always start REST (doesn't use stdio)
  startRestServer();

  // MCP mode: also start stdio MCP server for Claude Desktop
  if (MCP_MODE) {
    await startMcpServer();
  } else {
    log('');
    log('Waiting for ClashControl browser to connect...');
    log('Run with --mcp flag for Claude Desktop integration');
  }
}

main().catch((e) => {
  log('Fatal: ' + e.message);
  process.exit(1);
});
