# MCP Bridge

Connects any MCP (Model Context Protocol) server to agent-sh. Spawns servers as child processes over stdio, discovers their tools, and registers each as a native agent-sh tool.

## Setup

```bash
cp -r examples/extensions/mcp-bridge ~/.agent-sh/extensions/
cd ~/.agent-sh/extensions/mcp-bridge && npm install
```

## Configuration

Add server definitions to `~/.agent-sh/settings.json`:

```json
{
  "mcp-bridge": {
    "servers": {
      "vision": {
        "command": "npx",
        "args": ["-y", "@z_ai/mcp-server"],
        "env": {
          "Z_AI_API_KEY": "your-key",
          "Z_AI_MODE": "ZAI"
        }
      }
    }
  }
}
```

Each server entry:

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | Executable to spawn (e.g. `npx`, `node`) |
| `args` | `string[]` | Command arguments |
| `env` | `Record<string, string>` | Extra environment variables (merged with `process.env`) |

## How it works

On activation, the extension:

1. Reads `mcp-bridge.servers` from settings
2. Spawns each server as a child process with stdio transport
3. Connects via the MCP SDK client
4. Calls `listTools()` to discover available tools
5. Registers each tool as `mcp_{server}_{tool}` (e.g. `mcp_vision_image_analysis`)

Tools are then available to the agent like any built-in tool.

## Example: Z.AI Vision

```json
{
  "mcp-bridge": {
    "servers": {
      "vision": {
        "command": "npx",
        "args": ["-y", "@z_ai/mcp-server"],
        "env": {
          "Z_AI_API_KEY": "your-key",
          "Z_AI_MODE": "ZAI"
        }
      }
    }
  }
}
```

This gives the agent access to tools like `mcp_vision_image_analysis`, `mcp_vision_ui_to_artifact`, `mcp_vision_extract_text_from_screenshot`, etc.
