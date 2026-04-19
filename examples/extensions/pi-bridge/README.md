# pi-bridge

Runs [pi](https://github.com/nickarora/pi)'s full coding agent as an agent-sh backend. Uses pi's own configuration, models, tools, and extensions — agent-sh just provides the terminal.

## Install

```bash
# Copy or symlink into your extensions directory
cp -r examples/extensions/pi-bridge ~/.agent-sh/extensions/pi-bridge

# Install dependencies
cd ~/.agent-sh/extensions/pi-bridge
npm install
```

## Configure

Set as default backend in `~/.agent-sh/settings.json`:

```json
{
  "defaultBackend": "pi"
}
```

Or switch at runtime:

```
? /backend pi
```

## Requirements

- pi must be configured separately (`~/.pi/settings.json`) with API keys and model preferences
- agent-sh does not override pi's configuration — it uses whatever pi is set up with

## What this bridge is

A pure protocol translator between pi's event stream and agent-sh's bus events. Pi's built-in tools (command execution, file ops, etc.) are used exactly as pi ships them. The bridge adds no tools of its own.

## What this bridge intentionally does NOT bundle

Three PTY-access tools are left out on purpose:

- `terminal_read` — observe the user's live terminal screen
- `terminal_keys` — send keystrokes to the user's PTY
- `user_shell` — run commands in the user's live shell with lasting `cd`/`export`/`source` effects

These are opt-in capabilities that belong in their own extensions. If you want any of them with pi, write a small companion extension that registers the tool as a pi `ToolDefinition` (TypeBox schema, wired to the relevant bus event: `shell:pty-write`, `shell:exec-request`, or `ctx.terminalBuffer.readScreen()`) and load it alongside pi-bridge.

Keeping this split means the bridge stays narrow — only translating events — and the capability surface is composable per-backend.
