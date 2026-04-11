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
