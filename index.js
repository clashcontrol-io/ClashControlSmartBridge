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

// ── Tool definitions ─────────────────────────────────────────────
// Same enriched TOOLS as smart-bridge.js: desc (REST), mcpDesc (Claude), annotations, md (param descriptions)

const TOOLS = {
  get_status: {
    desc: 'Get current state: loaded models, clash count, active project, detection rules.',
    mcpDesc: 'Retrieve the current state of ClashControl: which IFC models are loaded, total clash count, active project name, and detection rule settings (gap tolerance, hard/soft mode). Call this first to confirm the browser is connected and models are loaded before running other tools.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {}
  },
  get_clashes: {
    desc: 'Get the clash list with details.',
    mcpDesc: 'Retrieve detected clash pairs between IFC model elements. Each clash includes the two colliding elements (with IFC type, discipline, storey), clash type (hard intersection or soft clearance violation), distance in mm, status (open/resolved), and priority level. Use after run_detection or to inspect existing results.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      status: { t:'string', e:['open','resolved','all'], md:'Filter clashes by resolution status: "open" = unresolved conflicts needing attention, "resolved" = already addressed, "all" = both' },
      limit: { t:'number', md:'Maximum number of clash pairs to return (default 50). Use lower values for overview, higher for full export.' }
    }
  },
  get_issues: {
    desc: 'Get the issues list.',
    mcpDesc: 'Retrieve the list of manually created issues (distinct from auto-detected clashes). Issues are user-authored coordination notes attached to the project.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { limit: { t:'number', md:'Maximum number of issues to return (default 50).' } }
  },
  run_detection: {
    desc: 'Run clash detection between model groups.',
    mcpDesc: 'Execute clash detection between two sets of IFC model elements. Specify model names, discipline labels, or "all". Use "+" to combine groups (e.g. "structural + architectural" vs "MEP"). Hard mode detects physical intersections; soft mode detects clearance violations within the gap tolerance. Results replace the current clash list.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      modelA: { t:'string', r:1, md:'First side of detection: model name, discipline label, or "all". Combine with "+" (e.g. "structural + architectural").' },
      modelB: { t:'string', r:1, md:'Second side of detection: model name, discipline label, or "all".' },
      maxGap: { t:'number', md:'Gap tolerance in millimeters (default 10). Elements closer than this trigger a soft clash.' },
      hard: { t:'boolean', md:'true = detect hard clashes (physical intersections only), false = detect soft clashes (clearance violations within gap tolerance).' },
      excludeSelf: { t:'boolean', md:'true = skip clashes between elements within the same model file.' }
    }
  },
  set_detection_rules: {
    desc: 'Update detection settings without running.',
    mcpDesc: 'Update clash detection configuration (gap tolerance, hard/soft mode, self-clash filtering, duplicate handling) without triggering a new detection run. Settings take effect on the next run_detection call.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      maxGap: { t:'number', md:'Gap tolerance in millimeters.' },
      hard: { t:'boolean', md:'true for hard/intersection mode, false for soft/clearance mode.' },
      excludeSelf: { t:'boolean', md:'Exclude self-clashes within same model.' },
      duplicates: { t:'boolean', md:'Include duplicate clash pairs in results.' }
    }
  },
  update_clash: {
    desc: 'Update a specific clash.',
    mcpDesc: 'Modify a single clash entry: change its resolution status, priority level, assigned reviewer, or descriptive title. Use clashIndex from the current clash list (0-based).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      clashIndex: { t:'number', r:1, md:'Zero-based index of the clash in the current list.' },
      status: { t:'string', e:['open','resolved'], md:'Set resolution status.' },
      priority: { t:'string', e:['critical','high','normal','low'], md:'Set priority level for triage.' },
      assignee: { t:'string', md:'Name of the person or team responsible for resolving this clash.' },
      title: { t:'string', md:'Short descriptive label for the clash.' }
    }
  },
  batch_update_clashes: {
    desc: 'Bulk update clashes.',
    mcpDesc: 'Bulk update multiple clashes at once by filter category. Can mass-resolve duplicates, set priority on all hard clashes, etc. Use with caution — affects many clashes at once.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    params: {
      action: { t:'string', e:['resolve','set_priority','set_status'], r:1, md:'Bulk action: "resolve" marks matching clashes as resolved, "set_priority" changes their priority, "set_status" changes their status.' },
      filter: { t:'string', e:['duplicates','soft','hard','all'], r:1, md:'Filter: "duplicates" = repeated clash pairs, "soft" = clearance violations, "hard" = physical intersections, "all" = every clash.' },
      value: { t:'string', md:'Value for the action (e.g. priority level for set_priority, status for set_status).' }
    }
  },
  set_view: {
    desc: 'Set camera to a preset angle.',
    mcpDesc: 'Set the 3D camera to a preset viewing angle. Useful for inspecting clashes from different perspectives or resetting the view.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { view: { t:'string', e:['top','front','back','left','right','isometric','reset'], r:1, md:'Camera preset angle. "reset" returns to the default view.' } }
  },
  set_render_style: {
    desc: 'Change 3D rendering style.',
    mcpDesc: 'Change how the 3D model is rendered. Wireframe is useful for seeing through elements to inspect internal clashes. Shaded/rendered modes show solid surfaces.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { style: { t:'string', e:['wireframe','shaded','rendered','standard'], r:1, md:'Rendering mode: wireframe (see-through), shaded (basic lighting), rendered (full materials), standard (default).' } }
  },
  set_section: {
    desc: 'Add or clear section cut plane.',
    mcpDesc: 'Apply a section cut plane to slice through the model along an axis, revealing internal geometry and hidden clashes. Use "none" to remove the cut.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { axis: { t:'string', e:['x','y','z','none'], r:1, md:'Cut axis (x/y/z), or "none" to remove the section plane.' } }
  },
  color_by: {
    desc: 'Color elements by property.',
    mcpDesc: 'Color-code all model elements by a grouping property. Discipline coloring helps visualize which teams own which elements; storey coloring shows vertical distribution; type coloring distinguishes element categories (beams, ducts, pipes, etc.).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { by: { t:'string', e:['type','storey','discipline','material','none'], r:1, md:'Color grouping: type (IFC class), storey (building level), discipline (MEP/structural/architectural), material, or none (reset).' } }
  },
  set_theme: {
    desc: 'Switch UI theme.',
    mcpDesc: 'Switch the ClashControl UI between dark and light theme.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { theme: { t:'string', e:['dark','light'], r:1 } }
  },
  set_visibility: {
    desc: 'Show or hide UI overlays.',
    mcpDesc: 'Toggle visibility of 3D viewport overlays: grid lines, coordinate axes, or clash markers.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      option: { t:'string', e:['grid','axes','markers'], r:1, md:'Overlay to toggle.' },
      visible: { t:'boolean', r:1, md:'true to show, false to hide.' }
    }
  },
  restore_visibility: {
    desc: 'Restore all hidden/ghosted elements.',
    mcpDesc: 'Restore all hidden, ghosted, or isolated elements back to full visibility. Resets any per-element visibility overrides.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {}
  },
  fly_to_clash: {
    desc: 'Fly camera to a clash.',
    mcpDesc: 'Animate the 3D camera to focus on a specific clash, centering the view on the collision point between the two elements. Use to visually inspect individual clashes.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { clashIndex: { t:'number', r:1, md:'Zero-based index of the clash to navigate to.' } }
  },
  navigate_tab: {
    desc: 'Switch to a UI tab.',
    mcpDesc: 'Switch the ClashControl sidebar to a specific tab: models (loaded IFC files), clashes (detection results), issues (manual notes), navigator (spatial tree), or ai (chat panel).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { tab: { t:'string', e:['models','clashes','issues','navigator','ai'], r:1 } }
  },
  filter_clashes: {
    desc: 'Filter the clash list.',
    mcpDesc: 'Apply filters to the displayed clash list by status and/or priority level. Does not modify clashes, only changes which ones are shown in the UI.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      status: { t:'string', e:['open','resolved','all'], md:'Filter by resolution status.' },
      priority: { t:'string', e:['critical','high','normal','low','all'], md:'Filter by priority level.' }
    }
  },
  sort_clashes: {
    desc: 'Sort the clash list.',
    mcpDesc: 'Sort the displayed clash list by a given property. Sorting by priority or distance helps identify the most critical or closest clashes first.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { sortBy: { t:'string', e:['priority','status','type','storey','date','distance'], r:1, md:'Property to sort by.' } }
  },
  group_clashes: {
    desc: 'Group clashes by category.',
    mcpDesc: 'Group the clash list by a category to identify patterns. Grouping by discipline shows which team pairs have the most conflicts; by storey shows which floors are most problematic.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { groupBy: { t:'string', e:['storey','discipline','status','type','none'], r:1, md:'Grouping category, or "none" to flatten.' } }
  },
  export_bcf: {
    desc: 'Export clashes/issues as BCF.',
    mcpDesc: 'Export all clashes and issues as a BCF (BIM Collaboration Format) file, triggering a download in the browser. BCF files can be imported into Revit, Navisworks, Solibri, and other BIM tools for coordination workflows.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { version: { t:'string', e:['2.1','3.0'], md:'BCF version: 2.1 (widest compatibility) or 3.0 (latest spec).' } }
  },
  create_project: {
    desc: 'Create a new project.',
    mcpDesc: 'Create a new ClashControl project. Projects organize clash detection sessions, allowing separate tracking for different buildings or coordination phases.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    params: { name: { t:'string', r:1, md:'Name for the new project.' } }
  },
  switch_project: {
    desc: 'Switch to a project by name.',
    mcpDesc: 'Switch to an existing project by name. Loads that project\'s models, clash results, and settings.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { name: { t:'string', r:1, md:'Project name or substring to match.' } }
  },
  measure: {
    desc: 'Start or stop measurement mode.',
    mcpDesc: 'Activate measurement mode in the 3D viewport: measure distances (length), angles between surfaces, or areas. Use "stop" to exit measurement mode, "clear" to remove measurement annotations.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { mode: { t:'string', e:['length','angle','area','stop','clear'], r:1, md:'Measurement type, or "stop"/"clear" to exit/reset.' } }
  },
  walk_mode: {
    desc: 'Enter or exit walk mode.',
    mcpDesc: 'Enter or exit first-person walk mode for navigating through the building model at human scale. Useful for understanding spatial relationships and clash locations in context.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { enabled: { t:'boolean', r:1, md:'true to enter walk mode, false to exit.' } }
  },
};

// ── MCP Server ────────────────────────────────────────────────────

const MCP_INSTRUCTIONS =
  'ClashControl is a BIM (Building Information Modeling) clash detection tool running in the browser. ' +
  'Every tool call is relayed to the ClashControl web app via WebSocket — the browser must be open with the Smart Bridge addon enabled. ' +
  'Typical workflow: (1) get_status to confirm connection and see loaded IFC models, ' +
  '(2) run_detection to find clashes between discipline groups (e.g. structural vs MEP), ' +
  '(3) get_clashes to review results, (4) fly_to_clash to inspect individual collisions, ' +
  '(5) update_clash or batch_update_clashes to triage. ' +
  'Hard clashes = physical intersections. Soft clashes = clearance violations within a gap tolerance (mm). ' +
  'Always start with get_status to verify the browser is connected and models are loaded.';

const server = new McpServer({ name: 'ClashControl', version: VERSION }, { instructions: MCP_INSTRUCTIONS });

// ── Register tools from shared TOOLS definition ──

for (const [name, tool] of Object.entries(TOOLS)) {
  const schema = {};
  for (const [pn, pd] of Object.entries(tool.params)) {
    if (pd.e) schema[pn] = pd.r ? z.enum(pd.e) : z.enum(pd.e).optional();
    else if (pd.t === 'number') schema[pn] = pd.r ? z.number() : z.number().optional();
    else if (pd.t === 'boolean') schema[pn] = pd.r ? z.boolean() : z.boolean().optional();
    else schema[pn] = pd.r ? z.string() : z.string().optional();
    const paramDesc = pd.md || pd.d;
    if (paramDesc && schema[pn].describe) schema[pn] = schema[pn].describe(paramDesc);
  }

  server.registerTool(name, {
    description: tool.mcpDesc || tool.desc,
    inputSchema: Object.keys(schema).length > 0 ? schema : undefined,
    annotations: tool.annotations
  }, async (params) => {
    try {
      const result = await sendToBrowser(name, params);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  });
}

// ── MCP Resources ──

server.registerResource('status', 'clashcontrol://status', {
  description: 'Current ClashControl state: loaded IFC models, clash count, active project, detection rules, browser connection status.',
  mimeType: 'application/json'
}, async (uri) => {
  try {
    const result = await sendToBrowser('get_status', {});
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: e.message, connected: false }) }] };
  }
});

server.registerResource('clash-summary', 'clashcontrol://clash-summary', {
  description: 'High-level clash summary: total counts by status, type, and priority.',
  mimeType: 'application/json'
}, async (uri) => {
  try {
    const result = await sendToBrowser('get_clashes', { status: 'all', limit: 500 });
    const clashes = Array.isArray(result) ? result : (result && result.clashes) || [];
    const summary = { total: clashes.length, byStatus: {}, byType: {}, byPriority: {} };
    for (const c of clashes) {
      if (c.status) summary.byStatus[c.status] = (summary.byStatus[c.status] || 0) + 1;
      if (c.type) summary.byType[c.type] = (summary.byType[c.type] || 0) + 1;
      if (c.priority) summary.byPriority[c.priority] = (summary.byPriority[c.priority] || 0) + 1;
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }] };
  } catch (e) {
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: e.message }) }] };
  }
});

// ── MCP Prompts ──

server.registerPrompt('analyze-clash-report', {
  description: 'Systematic analysis of current clash detection results with triage recommendations.'
}, async () => ({
  messages: [{ role: 'user', content: { type: 'text', text:
    'Analyze the current BIM clash detection results in ClashControl:\n\n' +
    '1. Call get_status to confirm which IFC models are loaded and current detection settings.\n' +
    '2. Call get_clashes with status "all" to retrieve the full clash list.\n' +
    '3. Summarize: total clashes, breakdown by status (open vs resolved), by type (hard vs soft), by priority, and by discipline pairs.\n' +
    '4. Identify patterns: clashes concentrated on specific storeys? Between specific disciplines? Clusters of duplicates?\n' +
    '5. Recommend a triage strategy: which clashes to address first, which might be false positives, and which discipline teams should coordinate.\n' +
    '6. If there are many duplicates, suggest using batch_update_clashes to resolve them before manual review.'
  }}]
}));

server.registerPrompt('investigate-clash', {
  description: 'Deep-dive investigation of a specific clash with visual inspection and resolution advice.',
  argsSchema: { clashIndex: z.string().describe('Zero-based index of the clash to investigate') }
}, async ({ clashIndex }) => ({
  messages: [{ role: 'user', content: { type: 'text', text:
    'Investigate clash #' + clashIndex + ' in ClashControl:\n\n' +
    '1. Call fly_to_clash with clashIndex ' + clashIndex + ' to navigate the 3D view to this clash.\n' +
    '2. Call get_clashes to get details about this clash (elements involved, type, distance, storey).\n' +
    '3. Try different viewing angles: set_view with "front", "top", and "isometric".\n' +
    '4. If elements are hard to see, try set_render_style with "wireframe" or color_by with "discipline".\n' +
    '5. Explain what the two clashing elements are, why they might be colliding, and whether this is a real coordination issue or a modeling artifact.\n' +
    '6. Suggest a resolution: flag as critical, assign to a discipline team, or resolve as false positive.'
  }}]
}));

server.registerPrompt('coordination-review', {
  description: 'Discipline coordination checklist for BIM review meetings.',
  argsSchema: { discipline: z.string().describe('Primary discipline to review, e.g. "structural", "mechanical", "electrical", "plumbing"') }
}, async ({ discipline }) => ({
  messages: [{ role: 'user', content: { type: 'text', text:
    'Run a coordination review for the ' + discipline + ' discipline:\n\n' +
    '1. Call get_status to see which models and disciplines are loaded.\n' +
    '2. Call get_clashes to find all clashes involving ' + discipline + ' elements.\n' +
    '3. Use group_clashes with "discipline" to see which other disciplines clash most with ' + discipline + '.\n' +
    '4. For each discipline pair, summarize: clash count, types (hard vs soft), affected storeys, severity.\n' +
    '5. Identify the top 3 most critical coordination issues needing team discussion.\n' +
    '6. Provide a checklist of action items for the ' + discipline + ' coordination lead.'
  }}]
}));

server.registerPrompt('compare-clash-runs', {
  description: 'Compare current clash results to track coordination progress over time.'
}, async () => ({
  messages: [{ role: 'user', content: { type: 'text', text:
    'Compare clash detection results to track coordination progress:\n\n' +
    '1. Call get_status to see the current project and detection settings.\n' +
    '2. Call get_clashes with status "all" to get the complete clash list.\n' +
    '3. Summarize: total clashes, open vs resolved, by type and priority.\n' +
    '4. Compute the resolution rate: what percentage of clashes are resolved?\n' +
    '5. Identify new open clashes with high/critical priority — these need immediate attention.\n' +
    '6. Produce a progress report for a BIM coordination meeting: overall trend, improvements, remaining problem areas, recommended next steps.'
  }}]
}));

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
