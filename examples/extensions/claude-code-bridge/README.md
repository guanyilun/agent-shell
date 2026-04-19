# claude-code-bridge

Runs Claude Code as an agent-sh backend using the official [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Install

```bash
# Copy or symlink into your extensions directory
cp -r examples/extensions/claude-code-bridge ~/.agent-sh/extensions/claude-code-bridge

# Install dependencies
cd ~/.agent-sh/extensions/claude-code-bridge
npm install
```

## Configure

Set as default backend in `~/.agent-sh/settings.json`:

```json
{
  "defaultBackend": "claude-code"
}
```

Or switch at runtime:

```
? /backend claude-code
```

## Requirements

- `ANTHROPIC_API_KEY` must be set in your environment
- Claude Code manages its own model selection — no model configuration needed in agent-sh

## What this bridge is

A pure protocol translator between the Claude Agent SDK's event stream and agent-sh's bus events. Claude Code uses its own built-in tools exactly as the SDK ships them (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`). The bridge adds no tools of its own.

## What this bridge intentionally does NOT bundle

Three PTY-access tools are left out on purpose:

- `terminal_read` — observe the user's live terminal screen
- `terminal_keys` — send keystrokes to the user's PTY
- `user_shell` — run commands in the user's live shell with lasting `cd`/`export`/`source` effects

These are opt-in capabilities that belong in their own extensions. If you want any of them with Claude Code, write a companion extension that uses the SDK's `tool()` + `createSdkMcpServer()` to expose them as MCP tools, and extend the bridge (or fork it) to attach that MCP server to the SDK's `query()` options.
