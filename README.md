# ClashControl Smart Bridge

**LLM bridge connecting Claude, ChatGPT, or any AI assistant to BIM clash detection.**

The Smart Bridge runs locally alongside ClashControl and exposes all its actions over two transports:

- **MCP (Model Context Protocol)** — for Claude Desktop and Claude Code
- **REST API** — for ChatGPT Custom GPTs, Copilot extensions, and any HTTP-capable LLM

---

## How It Works

```
Your AI Assistant  ←→  Smart Bridge  ←→  ClashControl browser extension
  (Claude / ChatGPT)    (this server)      (clashcontrol.io)
```

The bridge maintains a local WebSocket connection to the ClashControl browser extension on port `19802`. AI tools are relayed to the extension and results are returned to the LLM.

---

## Quick Start

### 1. Download and run (first time only)

Download the executable for your platform from the [releases page](https://github.com/clashcontrol-io/ClashControlSmartBridge/releases):

- **Windows:** `clashcontrol-smart-bridge-win.exe`
- **macOS:** `clashcontrol-smart-bridge-macos`
- **Linux:** `clashcontrol-smart-bridge-linux`

Run it once from your Downloads folder. On first launch it automatically copies itself to a permanent location:

| Platform | Install location |
|---|---|
| Windows | `%APPDATA%\ClashControl\` |
| macOS | `~/Library/Application Support/ClashControl/` |
| Linux | `~/.local/share/clashcontrol/` |

Once installed, it relaunches from there automatically. You will see:

```
[Smart Bridge] Installed to: C:\Users\...\AppData\Roaming\ClashControl\clashcontrol-smart-bridge.exe
[Smart Bridge] You can now delete the downloaded file from your Downloads folder.
[Smart Bridge] Relaunching...
```

**You can now delete the downloaded file from your Downloads folder.**

### 2. Run the bridge

On subsequent launches, run the bridge from its installed location (or add it to your startup programs):

**Default mode** (REST + WebSocket — for ChatGPT and generic LLMs):

```bash
clashcontrol-smart-bridge
```

**MCP mode** (for Claude Desktop / Claude Code):

```bash
clashcontrol-smart-bridge --mcp
```

### 3. Connect ClashControl

Open [clashcontrol.io](https://clashcontrol.io) in your browser and enable the **Smart Bridge** addon. The bridge will log `Browser connected via WebSocket` when the connection is established.

---

## Integration Guides

### Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "clashcontrol": {
      "command": "clashcontrol-smart-bridge",
      "args": ["--mcp"]
    }
  }
}
```

If you installed locally (not globally), use the full path to the binary:

```json
{
  "mcpServers": {
    "clashcontrol": {
      "command": "/path/to/ClashControlSmartBridge/smart-bridge.js",
      "args": ["--mcp"]
    }
  }
}
```

Restart Claude Desktop after saving. Claude will now have access to all 24 ClashControl tools.

### Claude Code (CLI)

Add the MCP server to your Claude Code config:

```bash
claude mcp add clashcontrol -- clashcontrol-smart-bridge --mcp
```

### ChatGPT Custom GPT

1. Run the bridge in default REST mode: `clashcontrol-smart-bridge`
2. In ChatGPT, go to **My GPTs → Create → Configure → Actions**
3. Click **Import from URL** and enter: `http://localhost:19803/openapi.json`
4. ChatGPT will automatically discover all available actions

> **Note:** ChatGPT requires a publicly accessible URL. Use a tool like `ngrok http 19803` to expose the local server if needed.

### Any LLM (REST API)

Point your LLM at the REST API. The OpenAPI 3.1 spec is available at `GET /openapi.json` and describes every available tool.

```bash
# Check bridge status
curl http://localhost:19803/status

# Run clash detection
curl -X POST http://localhost:19803/call/run_detection \
  -H "Content-Type: application/json" \
  -d '{"modelA": "Structure", "modelB": "MEP"}'

# Get all open clashes
curl -X POST http://localhost:19803/call/get_clashes \
  -H "Content-Type: application/json" \
  -d '{"status": "open", "limit": 50}'
```

---

## REST API Reference

The REST server starts on port `19803` by default (configurable via the `PORT` environment variable).

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Status page (HTML) |
| `/status` | GET | Bridge and browser connection status (JSON) |
| `/tools` | GET | List all available tools with schemas |
| `/openapi.json` | GET | OpenAPI 3.1 spec for ChatGPT Actions |
| `/call/{tool}` | POST | Invoke a tool with JSON body |

---

## Available Tools

### Status & Data

| Tool | Description |
|---|---|
| `get_status` | Current state: loaded models, clash count, active project, detection rules |
| `get_clashes` | Clash list with optional `status` filter (`open`/`resolved`/`all`) and `limit` |
| `get_issues` | Issues list with optional `limit` |

### Clash Detection

| Tool | Description |
|---|---|
| `run_detection` | Run clash detection between model groups (`modelA`, `modelB` required) |
| `set_detection_rules` | Update detection settings without running (`maxGap`, `hard`, `excludeSelf`, `duplicates`) |

### Clash Management

| Tool | Description |
|---|---|
| `update_clash` | Update a specific clash by index (status, priority, assignee, title) |
| `batch_update_clashes` | Bulk update clashes by filter (resolve, set_priority, set_status) |

### 3D View Controls

| Tool | Description |
|---|---|
| `set_view` | Camera preset: `top`, `front`, `back`, `left`, `right`, `isometric`, `reset` |
| `set_render_style` | Rendering mode: `wireframe`, `shaded`, `rendered`, `standard` |
| `set_section` | Section cut plane along `x`, `y`, `z` axis, or `none` to clear |
| `color_by` | Color elements by `type`, `storey`, `discipline`, `material`, or `none` |
| `set_theme` | Switch UI theme: `dark` or `light` |
| `set_visibility` | Show/hide `grid`, `axes`, or `markers` |
| `restore_visibility` | Restore all hidden or ghosted elements |

### Navigation

| Tool | Description |
|---|---|
| `fly_to_clash` | Fly camera to a clash by index |
| `navigate_tab` | Switch UI tab: `models`, `clashes`, `issues`, `navigator`, `ai` |

### Filtering & Sorting

| Tool | Description |
|---|---|
| `filter_clashes` | Filter clash list by status and/or priority |
| `sort_clashes` | Sort by `priority`, `status`, `type`, `storey`, `date`, or `distance` |
| `group_clashes` | Group by `storey`, `discipline`, `status`, `type`, or `none` |

### Export

| Tool | Description |
|---|---|
| `export_bcf` | Export clashes/issues as BCF `2.1` or `3.0` |

### Projects

| Tool | Description |
|---|---|
| `create_project` | Create a new project by name |
| `switch_project` | Switch to an existing project by name |

### Measurement & Navigation

| Tool | Description |
|---|---|
| `measure` | Start/stop measurement mode: `length`, `angle`, `area`, `stop`, or `clear` |
| `walk_mode` | Enable or disable first-person walk mode |

---

## Ports

| Service | Port | Configurable |
|---|---|---|
| WebSocket bridge (browser ↔ bridge) | `19802` | No |
| REST API | `19803` | Yes — `PORT` env var |

```bash
PORT=8080 clashcontrol-smart-bridge
```

---

## Building Standalone Binaries

Package the bridge as a self-contained executable (no Node.js required on target machine):

```bash
npm run bundle
```

Outputs to `dist/`:
- `clashcontrol-smart-bridge-win.exe` (Windows x64)
- `clashcontrol-smart-bridge-macos` (macOS x64)
- `clashcontrol-smart-bridge-linux` (Linux x64)

---

## Troubleshooting

**"ClashControl is not connected"**
- Make sure clashcontrol.io is open in your browser
- Enable the Smart Bridge addon in the ClashControl settings
- Check the bridge log for `Browser connected via WebSocket`

**Port 19802 already in use**
- If another instance of the bridge is already running, new instances automatically connect to the existing WebSocket server instead of starting a new one. This is normal when running both MCP and REST modes simultaneously.

**Claude Desktop doesn't see the tools**
- Verify the path in `claude_desktop_config.json` is correct
- Restart Claude Desktop after any config change
- Check that the `--mcp` flag is included in `args`

---

## License

MIT
