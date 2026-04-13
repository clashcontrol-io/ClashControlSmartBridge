#!/usr/bin/env node
// ── ClashControl Smart Bridge — REST Transport ───────────────────
// Universal HTTP API that forwards requests to ClashControl in the
// browser via WebSocket. Part of the Smart Bridge — works with any
// LLM (ChatGPT, Gemini, Llama, etc.) or plain HTTP clients.
//
// Usage:
//   node rest-bridge.js                  # default port 19803
//   PORT=8080 node rest-bridge.js        # custom port
//
// Endpoints:
//   GET  /status          — bridge + browser connection status
//   GET  /tools           — list available tools (for LLM integration)
//   POST /call/:action    — execute a tool (body = params JSON)
//   GET  /openapi.json    — OpenAPI 3.1 spec (for ChatGPT Actions)

const http = require('http');
const WebSocket = require('ws');

const REST_PORT = parseInt(process.env.PORT, 10) || 19803;
const WS_PORT = 19802;
const REQUEST_TIMEOUT = 15000;

// ── WebSocket bridge to browser ───────────────────────────────────

let wss = null;
let browserSocket = null;
let pendingRequests = new Map();
let requestId = 0;

function startWsBridge() {
  wss = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    browserSocket = ws;
    console.log('[Smart Bridge REST] Browser connected via WebSocket');
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
        console.error('[Smart Bridge REST] Bad WS message:', e.message);
      }
    });
    ws.on('close', () => {
      browserSocket = null;
      console.log('[Smart Bridge REST] Browser disconnected');
    });
  });
  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[Smart Bridge REST] WebSocket port ' + WS_PORT + ' in use (MCP server running?) — connecting as client instead');
      connectAsClient();
    } else {
      console.error('[Smart Bridge REST] WebSocket error:', err.message);
    }
  });
}

// If MCP server already owns the WS port, connect as a client relay
function connectAsClient() {
  const ws = new WebSocket('ws://127.0.0.1:' + WS_PORT);
  ws.on('open', () => {
    browserSocket = ws;
    console.log('[Smart Bridge REST] Connected to existing WebSocket bridge');
  });
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
  ws.on('close', () => {
    browserSocket = null;
    console.log('[Smart Bridge REST] WebSocket disconnected, retrying in 5s...');
    setTimeout(connectAsClient, 5000);
  });
  ws.on('error', () => {});
}

function sendToBrowser(action, params) {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('ClashControl is not connected. Open clashcontrol.io in your browser and enable the Smart Bridge addon.'));
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

// ── Tool definitions ──────────────────────────────────────────────

const TOOLS = {
  get_status: {
    description: 'Get current state of ClashControl: loaded IFC models, clash count, active project, and detection rules.',
    params: {}
  },
  get_clashes: {
    description: 'Get detected clash pairs between IFC elements with type, storey, status, priority, and element details.',
    params: {
      status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Filter by resolution status (default: open)' },
      limit: { type: 'number', description: 'Max clashes to return (default 50)' }
    }
  },
  get_issues: {
    description: 'Get manually created coordination issues (distinct from auto-detected clashes).',
    params: {
      limit: { type: 'number', description: 'Max issues to return (default 50)' }
    }
  },
  run_detection: {
    description: 'Run clash detection between two sets of IFC model elements. Hard mode = physical intersections, soft mode = clearance violations.',
    params: {
      modelA: { type: 'string', description: 'First side: model name, discipline, or "all". Use "+" for groups (e.g. "structural + architectural").', required: true },
      modelB: { type: 'string', description: 'Second side: model name, discipline, or "all".', required: true },
      maxGap: { type: 'number', description: 'Gap tolerance in mm (default 10). Elements closer than this trigger a soft clash.' },
      hard: { type: 'boolean', description: 'true = hard/intersection clashes only, false = soft/clearance violations' },
      excludeSelf: { type: 'boolean', description: 'Skip clashes between elements within the same model' }
    }
  },
  set_detection_rules: {
    description: 'Update clash detection settings (gap tolerance, hard/soft mode) without running detection.',
    params: {
      maxGap: { type: 'number', description: 'Gap tolerance in mm' },
      hard: { type: 'boolean', description: 'true for hard/intersection mode, false for soft/clearance mode' },
      excludeSelf: { type: 'boolean', description: 'Exclude self-clashes within same model' },
      duplicates: { type: 'boolean', description: 'Include duplicate clash pairs' }
    }
  },
  update_clash: {
    description: 'Update a single clash: change status, priority, assignee, or title.',
    params: {
      clashIndex: { type: 'number', description: 'Zero-based index of the clash in the current list', required: true },
      status: { type: 'string', enum: ['open', 'resolved'], description: 'Resolution status' },
      priority: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Priority level' },
      assignee: { type: 'string', description: 'Person or team responsible' },
      title: { type: 'string', description: 'Short descriptive label' }
    }
  },
  batch_update_clashes: {
    description: 'Bulk update multiple clashes by filter. Can mass-resolve duplicates, set priority on all hard clashes, etc.',
    params: {
      action: { type: 'string', enum: ['resolve', 'set_priority', 'set_status'], description: 'Bulk action to perform', required: true },
      filter: { type: 'string', enum: ['duplicates', 'soft', 'hard', 'all'], description: 'Which clashes to target', required: true },
      value: { type: 'string', description: 'Value for the action (e.g. priority level)' }
    }
  },
  set_view: {
    description: 'Set the 3D camera to a preset viewing angle.',
    params: { view: { type: 'string', enum: ['top', 'front', 'back', 'left', 'right', 'isometric', 'reset'], description: 'Camera preset', required: true } }
  },
  set_render_style: {
    description: 'Change 3D rendering: wireframe (see-through), shaded, rendered (full materials), or standard.',
    params: { style: { type: 'string', enum: ['wireframe', 'shaded', 'rendered', 'standard'], description: 'Rendering mode', required: true } }
  },
  set_section: {
    description: 'Apply a section cut plane to slice through the model, or remove it with "none".',
    params: { axis: { type: 'string', enum: ['x', 'y', 'z', 'none'], description: 'Cut axis or "none" to clear', required: true } }
  },
  color_by: {
    description: 'Color-code model elements by type (IFC class), storey, discipline, material, or reset with "none".',
    params: { by: { type: 'string', enum: ['type', 'storey', 'discipline', 'material', 'none'], description: 'Color grouping', required: true } }
  },
  set_theme: {
    description: 'Switch ClashControl UI between dark and light theme.',
    params: { theme: { type: 'string', enum: ['dark', 'light'], required: true } }
  },
  set_visibility: {
    description: 'Toggle visibility of 3D viewport overlays: grid, axes, or clash markers.',
    params: {
      option: { type: 'string', enum: ['grid', 'axes', 'markers'], description: 'Overlay to toggle', required: true },
      visible: { type: 'boolean', description: 'true to show, false to hide', required: true }
    }
  },
  restore_visibility: {
    description: 'Restore all hidden, ghosted, or isolated elements back to full visibility.',
    params: {}
  },
  fly_to_clash: {
    description: 'Fly the 3D camera to focus on a specific clash by index.',
    params: { clashIndex: { type: 'number', description: 'Zero-based clash index', required: true } }
  },
  navigate_tab: {
    description: 'Switch the ClashControl sidebar to a tab: models, clashes, issues, navigator, or ai.',
    params: { tab: { type: 'string', enum: ['models', 'clashes', 'issues', 'navigator', 'ai'], required: true } }
  },
  filter_clashes: {
    description: 'Filter the displayed clash list by status and/or priority (UI only, does not modify data).',
    params: {
      status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Filter by resolution status' },
      priority: { type: 'string', enum: ['critical', 'high', 'normal', 'low', 'all'], description: 'Filter by priority level' }
    }
  },
  sort_clashes: {
    description: 'Sort the clash list by priority, status, type, storey, date, or distance.',
    params: { sortBy: { type: 'string', enum: ['priority', 'status', 'type', 'storey', 'date', 'distance'], description: 'Sort property', required: true } }
  },
  group_clashes: {
    description: 'Group clashes by category to identify patterns (e.g. discipline pairs with most conflicts).',
    params: { groupBy: { type: 'string', enum: ['storey', 'discipline', 'status', 'type', 'none'], description: 'Grouping category', required: true } }
  },
  export_bcf: {
    description: 'Export clashes/issues as a BCF file for import into Revit, Navisworks, Solibri, etc.',
    params: { version: { type: 'string', enum: ['2.1', '3.0'], description: 'BCF version (2.1 = widest compatibility)' } }
  },
  create_project: {
    description: 'Create a new ClashControl project for organizing clash detection sessions.',
    params: { name: { type: 'string', description: 'Project name', required: true } }
  },
  switch_project: {
    description: 'Switch to an existing project, loading its models, clashes, and settings.',
    params: { name: { type: 'string', description: 'Project name or substring to match', required: true } }
  },
  measure: {
    description: 'Activate measurement mode: length, angle, or area. Use "stop" to exit, "clear" to remove annotations.',
    params: { mode: { type: 'string', enum: ['length', 'angle', 'area', 'stop', 'clear'], description: 'Measurement type or control', required: true } }
  },
  walk_mode: {
    description: 'Enter or exit first-person walk mode for human-scale building navigation.',
    params: { enabled: { type: 'boolean', description: 'true to enter, false to exit', required: true } }
  }
};

// ── OpenAPI spec generation ───────────────────────────────────────

function generateOpenAPISpec() {
  const paths = {};

  // Status endpoint
  paths['/status'] = {
    get: {
      operationId: 'getStatus',
      summary: 'Get bridge and browser connection status',
      responses: { '200': { description: 'Status object', content: { 'application/json': { schema: { type: 'object' } } } } }
    }
  };

  // Tools list
  paths['/tools'] = {
    get: {
      operationId: 'listTools',
      summary: 'List all available tools',
      responses: { '200': { description: 'Tool list', content: { 'application/json': { schema: { type: 'object' } } } } }
    }
  };

  // Tool endpoints
  for (const [name, tool] of Object.entries(TOOLS)) {
    const properties = {};
    const required = [];
    for (const [pName, pDef] of Object.entries(tool.params)) {
      properties[pName] = { type: pDef.type || 'string' };
      if (pDef.enum) properties[pName].enum = pDef.enum;
      if (pDef.description) properties[pName].description = pDef.description;
      if (pDef.required) required.push(pName);
    }

    paths['/call/' + name] = {
      post: {
        operationId: name,
        summary: tool.description,
        requestBody: Object.keys(properties).length > 0 ? {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: properties,
                ...(required.length > 0 ? { required } : {})
              }
            }
          }
        } : undefined,
        responses: {
          '200': {
            description: 'Tool result',
            content: { 'application/json': { schema: { type: 'object' } } }
          },
          '502': { description: 'Browser not connected' },
          '504': { description: 'Request timed out' }
        }
      }
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ClashControl API',
      description: 'Control ClashControl BIM clash detection from any LLM or HTTP client. Requires ClashControl open in a browser with the Smart Bridge addon enabled.',
      version: '0.1.0'
    },
    servers: [
      { url: 'http://localhost:' + REST_PORT, description: 'Local bridge' }
    ],
    paths: paths
  };
}

// ── HTTP Server ───────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') { resolve({}); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers (allow ChatGPT and other origins)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // JSON response helper
  function json(status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // GET /status
  if (path === '/status' && req.method === 'GET') {
    json(200, {
      bridge: 'running',
      browser: browserSocket && browserSocket.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      wsPort: WS_PORT,
      tools: Object.keys(TOOLS).length
    });
    return;
  }

  // GET /tools
  if (path === '/tools' && req.method === 'GET') {
    json(200, { tools: TOOLS });
    return;
  }

  // GET /openapi.json
  if (path === '/openapi.json' && req.method === 'GET') {
    json(200, generateOpenAPISpec());
    return;
  }

  // POST /call/:action
  const callMatch = path.match(/^\/call\/([a-z_]+)$/);
  if (callMatch && req.method === 'POST') {
    const action = callMatch[1];
    if (!TOOLS[action]) {
      json(404, { error: 'Unknown tool: ' + action });
      return;
    }
    const params = await parseBody(req);
    try {
      const result = await sendToBrowser(action, params);
      json(200, { result });
    } catch (e) {
      const status = e.message.includes('not connected') ? 502 : 504;
      json(status, { error: e.message });
    }
    return;
  }

  // GET / — landing page
  if (path === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html><head><title>ClashControl Smart Bridge</title></head>
<body style="font-family:system-ui;max-width:700px;margin:2rem auto;padding:0 1rem;color:#e2e8f0;background:#0f172a">
<h1 style="color:#f59e0b">ClashControl Smart Bridge</h1>
<p>LLM bridge — connect Claude, ChatGPT, or any AI assistant to control ClashControl with natural language.</p>
<h3>Endpoints</h3>
<ul>
<li><code>GET /status</code> — connection status</li>
<li><code>GET /tools</code> — list available tools</li>
<li><code>POST /call/{action}</code> — execute a tool</li>
<li><code>GET /openapi.json</code> — OpenAPI 3.1 spec (ChatGPT Actions)</li>
</ul>
<h3>ChatGPT Setup</h3>
<ol>
<li>Create a custom GPT at <a href="https://chat.openai.com/gpts/editor" style="color:#60a5fa">chat.openai.com/gpts/editor</a></li>
<li>Go to <b>Configure → Actions → Import from URL</b></li>
<li>Enter: <code>http://localhost:${REST_PORT}/openapi.json</code></li>
<li>Save — ChatGPT can now call ClashControl tools</li>
</ol>
<h3>Quick test</h3>
<pre style="background:#1e293b;padding:1rem;border-radius:8px;overflow-x:auto">curl http://localhost:${REST_PORT}/status
curl -X POST http://localhost:${REST_PORT}/call/get_status
curl -X POST http://localhost:${REST_PORT}/call/set_view -H "Content-Type: application/json" -d '{"view":"top"}'</pre>
<p style="color:#94a3b8;font-size:0.85rem">Browser status: <span id="s">checking...</span></p>
<script>fetch('/status').then(r=>r.json()).then(d=>{document.getElementById('s').textContent=d.browser;document.getElementById('s').style.color=d.browser==='connected'?'#22c55e':'#ef4444'})</script>
</body></html>`);
    return;
  }

  json(404, { error: 'Not found' });
});

// ── Start ─────────────────────────────────────────────────────────

startWsBridge();
server.listen(REST_PORT, '127.0.0.1', () => {
  console.log('[ClashControl Smart Bridge] LLM bridge for Claude, ChatGPT, and more');
  console.log('  HTTP API:    http://127.0.0.1:' + REST_PORT);
  console.log('  OpenAPI:     http://127.0.0.1:' + REST_PORT + '/openapi.json');
  console.log('  WebSocket:   ws://127.0.0.1:' + WS_PORT);
  console.log('');
  console.log('  Waiting for ClashControl browser to connect...');
});
