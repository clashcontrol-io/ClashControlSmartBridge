// ── ClashControl Tool Definitions ─────────────────────────────────
// Shared by smart-bridge.js (REST + MCP) and index.js (MCP standalone).
// Fields: desc (REST/OpenAPI), mcpDesc (richer Claude description), annotations (MCP safety hints)
// Param fields: t (type), e (enum), r (required), d (REST desc), md (MCP desc)

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
      status: { t:'string', e:['open','resolved','all'], d:'Filter by status', md:'Filter clashes by resolution status: "open" = unresolved conflicts needing attention, "resolved" = already addressed, "all" = both' },
      limit: { t:'number', d:'Max clashes to return', md:'Maximum number of clash pairs to return (default 50). Use lower values for overview, higher for full export.' }
    }
  },
  get_issues: {
    desc: 'Get the issues list.',
    mcpDesc: 'Retrieve the list of manually created issues (distinct from auto-detected clashes). Issues are user-authored coordination notes attached to the project.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { limit: { t:'number', d:'Max issues to return', md:'Maximum number of issues to return (default 50).' } }
  },
  run_detection: {
    desc: 'Run clash detection between model groups.',
    mcpDesc: 'Execute clash detection between two sets of IFC model elements. Specify model names, discipline labels, or "all". Use "+" to combine groups (e.g. "structural + architectural" vs "MEP"). Hard mode detects physical intersections; soft mode detects clearance violations within the gap tolerance. Results replace the current clash list.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      modelA: { t:'string', r:1, d:'First side: model name, discipline, or "all". Use "+" for groups.', md:'First side of detection: model name, discipline label, or "all". Combine with "+" (e.g. "structural + architectural").' },
      modelB: { t:'string', r:1, d:'Second side', md:'Second side of detection: model name, discipline label, or "all".' },
      maxGap: { t:'number', d:'Gap mm', md:'Gap tolerance in millimeters (default 10). Elements closer than this trigger a soft clash.' },
      hard: { t:'boolean', md:'true = detect hard clashes (physical intersections only), false = detect soft clashes (clearance violations within gap tolerance).' },
      excludeSelf: { t:'boolean', md:'true = skip clashes between elements within the same model file.' }
    }
  },
  set_detection_rules: {
    desc: 'Update detection settings without running.',
    mcpDesc: 'Update clash detection configuration (gap tolerance, hard/soft mode, self-clash filtering, duplicate handling) without triggering a new detection run. Settings take effect on the next run_detection call.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      maxGap: { t:'number', d:'Gap mm', md:'Gap tolerance in millimeters.' },
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
      clashIndex: { t:'number', r:1, d:'Clash index', md:'Zero-based index of the clash in the current list.' },
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
      action: { t:'string', e:['resolve','set_priority','set_status'], r:1, d:'Action to perform', md:'Bulk action: "resolve" marks matching clashes as resolved, "set_priority" changes their priority, "set_status" changes their status.' },
      filter: { t:'string', e:['duplicates','soft','hard','all'], r:1, d:'Which clashes to target', md:'Filter: "duplicates" = repeated clash pairs, "soft" = clearance violations, "hard" = physical intersections, "all" = every clash.' },
      value: { t:'string', d:'New value for the action', md:'Value for the action (e.g. priority level for set_priority, status for set_status).' }
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

// ── MCP Registration Helper ──────────────────────────────────────

const MCP_INSTRUCTIONS =
  'ClashControl is a BIM (Building Information Modeling) clash detection tool running in the browser. ' +
  'Every tool call is relayed to the ClashControl web app via WebSocket — the browser must be open with the Smart Bridge addon enabled. ' +
  'Typical workflow: (1) get_status to confirm connection and see loaded IFC models, ' +
  '(2) run_detection to find clashes between discipline groups (e.g. structural vs MEP), ' +
  '(3) get_clashes to review results, (4) fly_to_clash to inspect individual collisions, ' +
  '(5) update_clash or batch_update_clashes to triage. ' +
  'Hard clashes = physical intersections. Soft clashes = clearance violations within a gap tolerance (mm). ' +
  'Always start with get_status to verify the browser is connected and models are loaded.';

function registerMcpTools(mcp, z, sendToBrowser) {
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

    mcp.registerTool(name, {
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
}

module.exports = { TOOLS, MCP_INSTRUCTIONS, registerMcpTools };
