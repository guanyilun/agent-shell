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

Requires Node.js 18+. See the [Usage Guide](docs/usage.md) for provider examples, model configuration, and environment variables.

### Provider Examples

```bash
# OpenAI
OPENAI_API_KEY="sk-..." agent-sh --model gpt-4o

# Ollama (local, no API key)
agent-sh --api-key dummy --base-url http://localhost:11434/v1 --model llama3

# OpenRouter
agent-sh --api-key "$OPENROUTER_KEY" --base-url https://openrouter.ai/api/v1 --model anthropic/claude-sonnet-4-20250514

# Together AI
agent-sh --api-key "$TOGETHER_KEY" --base-url https://api.together.xyz/v1 --model meta-llama/Llama-3-70b-chat-hf

# LM Studio
agent-sh --api-key dummy --base-url http://localhost:1234/v1 --model local-model
```

## Input Modes

agent-sh has two agent input modes, each triggered by a single character at the start of an empty line:

| Trigger | Mode | Behavior |
|---|---|---|
| `?` | **Query** | Agent uses its own tools (bash, file read/write, search) to investigate and answer. Stays in query mode after each response. |
| `>` | **Execute** | Agent runs a command in your live shell via `user_shell`. Your aliases, env vars, and cwd apply. Returns to shell after execution. |

Regular shell input works as before — commands go straight to the PTY:

| Input | Behavior |
|---|---|
| `ls -la` | Runs in real shell (PTY), output displayed normally |
| `cd src && make` | Real shell — cd, env, aliases all just work |
| `vim file.ts` | Opens vim in the same PTY, no hacks needed |
| `? refactor this fn` | Query mode — agent investigates and responds |
| `> restart the server` | Execute mode — agent runs it in your live shell |
| `? /help` | Shows available slash commands (works in either mode) |
| `Ctrl-C` | Standard signal to shell, or cancels active agent response |
| `Ctrl-O` | Expand/collapse truncated diff preview |
| `Ctrl-T` | Toggle thinking/reasoning text display |
| `Shift-Tab` | Cycle agent mode (model switching, thinking levels) |
| `Escape` | Exit agent input mode |

Modes are extensible — extensions can register new modes via the `input-mode:register` event (see [Extensions](docs/extensions.md#custom-input-modes)).

### Agent Input Keybindings

When typing in either agent mode (`?` or `>`), full readline-style keybindings are available:

| Key | Action |
|---|---|
| `↑` / `↓` | Browse query history (persisted across sessions) |
| `Shift-Enter` | Insert newline (multiline input) |
| `Shift-Tab` | Cycle agent mode |
| `Ctrl-D` | Exit agent input mode (on empty line) |
| `Ctrl-A` / `Home` | Move to start of line |
| `Ctrl-E` / `End` | Move to end of line |
| `Ctrl-B` / `←` | Move back one character |
| `Ctrl-F` / `→` | Move forward one character |
| `Option-B` / `Option-←` | Move back one word |
| `Option-F` / `Option-→` | Move forward one word |
| `Ctrl-U` | Delete to start of line |
| `Ctrl-K` | Delete to end of line |
| `Ctrl-W` / `Option-Backspace` | Delete word backward |
| `Option-D` | Delete word forward |

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Start a new agent session |
| `/copy` | Copy last agent response to clipboard |
| `/compact` | Ask agent to summarize the conversation |
| `/quit` | Exit agent-sh |

## Configuration

agent-sh stores settings and history in `~/.agent-sh/`. Behavior is configurable via `~/.agent-sh/settings.json` — context window size, truncation thresholds, display limits, and more. All fields are optional with sensible defaults.

See the [Usage Guide](docs/usage.md#configuration) for the full settings reference.

## Development

```bash
npm run dev                        # development mode (no build step)
npm run build                      # build
npm start                          # run built version
DEBUG=1 npm start                  # debug mode (logs protocol details)
```

## Documentation

- [Usage Guide](docs/usage.md) — providers, models, API keys, environment config
- [Architecture](docs/architecture.md) — design philosophy, event bus, project structure
- [Extensions](docs/extensions.md) — writing extensions, theming, content transforms
- [Library Usage](docs/library.md) — using agent-sh as a Node.js library
- [Troubleshooting](docs/troubleshooting.md) — common errors and debug mode

## License

MIT
