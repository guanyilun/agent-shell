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
