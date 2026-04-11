# agent-sh

[![npm version](https://img.shields.io/npm/v/agent-sh.svg)](https://www.npmjs.com/package/agent-sh)
[![license](https://img.shields.io/npm/l/agent-sh.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

Not a shell that lives in an agent — an agent that lives in a shell.

agent-sh is a real terminal first. Every keystroke goes to a real PTY. `cd`, pipes, vim, job control — they all just work. But type `?` or `>` at the start of a line, and you're talking to an AI agent that has full context of what you've been doing: your working directory, recent commands, their output.

Works with any OpenAI-compatible API: OpenAI, Anthropic (via compatible endpoint), Ollama, OpenRouter, Together, Groq, LM Studio, vLLM, and more.

```
⚡ src $ ls -la                          # real shell command
⚡ src $ cd ../tests && npm test          # real cd, env, aliases — all just work
⚡ src $ vim file.ts                      # opens vim in the same PTY
⚡ src $ ? explain the last error         # query mode → agent investigates using its own tools
⚡ src $ > deploy to staging              # execute mode → agent runs it in your live shell
```

## Why shell-first?

I live mostly in a terminal. I don't just want an agent that has access to my shell — I want a shell that has access to my agent.

Most AI coding tools get this backwards: the LLM drives the experience and the shell is bolted on. That means no real PTY, no job control, no interactive commands, and fragile `cd` tracking that reimplements what bash gives you for free.

agent-sh starts from the opposite end. The shell is the primary interface — it's your terminal, not the agent's. The agent is a tool you reach for when you need it, not the other way around. Two modes give you fine-grained control: `?` for questions and tasks (agent uses its own tools), `>` for commands that run directly in your live shell.

## Key Features

- **Real Terminal** — Full PTY, job control, pipes, vim, ssh — everything just works
- **Zero Latency** — Shell starts instantly, agent connects asynchronously
- **Any LLM Provider** — OpenAI, Anthropic, Ollama, OpenRouter, or any OpenAI-compatible API
- **Context Aware** — Agent sees your cwd, recent commands, and their output
- **Dual Input Modes** — `?` for questions/tasks (agent tools), `>` for live shell execution
- **Streaming** — Responses stream live with syntax highlighting and thinking display
- **Built-in Tools** — File read/write/edit, bash, grep, glob, ls — no external setup
- **Inline Diff Preview** — File writes show syntax-highlighted diffs inline (Ctrl+O to expand)
- **Command Suggestions** — Failed commands get automatic fix suggestions (when LLM is available)
- **Token Tracking** — Per-response token usage display
- **Extensible** — Plugin system with content transforms, custom input modes, theming
- **Pluggable Backends** — Swap in pi or Claude Code as the agent backend via extensions

## Quick Start

```bash
# Install
npm install -g agent-sh

# Run with any OpenAI-compatible API
OPENAI_API_KEY="your-key" agent-sh --model gpt-4o

# Or with a custom provider
agent-sh --api-key "$KEY" --base-url http://localhost:11434/v1 --model llama3

# Or with a backend extension (pi, Claude Code, etc.)
# See examples/extensions/ for setup instructions
```

Requires Node.js 18+. Works with any OpenAI-compatible API — see the [Usage Guide](docs/usage.md) for provider examples (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio, vLLM).

## Input Modes

agent-sh has two agent input modes, triggered by typing `?` or `>` at the start of an empty line:

- **`?` Query mode** — Agent uses its own tools (bash, file read/write, search) to investigate and answer. Stays in query mode for follow-ups.
- **`>` Execute mode** — Agent runs a command in your live shell. Your aliases, env vars, and cwd apply. Returns to shell after.

Everything else works as a normal shell — commands go straight to the PTY. `Ctrl-C` cancels an active agent response, `Ctrl-O` expands truncated diffs, `Shift-Tab` cycles models. Modes are extensible — see [Extensions: Custom Input Modes](docs/extensions.md#custom-input-modes).

### Slash Commands

Type these in either agent mode:

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Start a new agent session |
| `/copy` | Copy last agent response to clipboard |
| `/compact` | Summarize the conversation to free context |
| `/model` | Cycle to the next model (same as Shift+Tab) |
| `/provider <name>` | Switch to a different provider |
| `/backend [name]` | List backends, or switch to a named backend |
| `/quit` | Exit agent-sh |

## Configuration

agent-sh stores settings and history in `~/.agent-sh/`. Configure via `~/.agent-sh/settings.json`:

```json
{
  "defaultProvider": "openai",
  "defaultBackend": "agent-sh",
  "providers": {
    "openai": {
      "apiKey": "$OPENAI_API_KEY",
      "defaultModel": "gpt-4o",
      "models": ["gpt-4o", "gpt-4o-mini"]
    },
    "ollama": {
      "apiKey": "not-needed",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "llama3",
      "models": ["llama3", "mistral"]
    }
  }
}
```

Define named providers with multiple models, then cycle between them at runtime with **Shift+Tab** or `/model`. Switch providers with `/provider <name>`. API keys support `$ENV_VAR` syntax so you don't store secrets in the file.

See the [Usage Guide](docs/usage.md#configuration) for the full settings reference.

## Development

```bash
npm run dev                        # development mode (no build step)
npm run build                      # build
npm start                          # run built version
DEBUG=1 npm start                  # debug mode (logs protocol details)
```

## Documentation

- [Usage Guide](docs/usage.md) — providers, models, configuration, provider profiles
- [Internal Agent](docs/agent.md) — how the agent loop works: tools, context, streaming
- [Architecture](docs/architecture.md) — design philosophy, component overview, project structure
- [Extensions](docs/extensions.md) — event bus, content transforms, custom backends, theming
- [Library Usage](docs/library.md) — embedding agent-sh in your own apps
- [Troubleshooting](docs/troubleshooting.md) — common errors and debug mode

## License

MIT
