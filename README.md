# agent-sh

[![npm version](https://img.shields.io/npm/v/agent-sh.svg)](https://www.npmjs.com/package/agent-sh)
[![license](https://img.shields.io/npm/l/agent-sh.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

Not a shell that lives in an agent — an agent that lives in a shell.

agent-sh is a real terminal first. Every keystroke goes to a real PTY. `cd`, pipes, vim, job control — they all just work. But type `>` at the start of a line, and you're talking to an AI agent that has full context of what you've been doing: your working directory, recent commands, their output.

The agent connects via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), so you can plug in **any** ACP-compatible agent: [pi](https://github.com/svkozak/pi-acp), claude-code, codex, gemini-cli, goose, etc.

```
⚡ src $ ls -la                          # real shell command
⚡ src $ cd ../tests && npm test          # real cd, env, aliases — all just work
⚡ src $ vim file.ts                      # opens vim in the same PTY
⚡ src $ > refactor the auth middleware   # → sent to agent via ACP
⚡ src $ > explain the last error         # agent sees your recent commands + output
```

## Why shell-first?

Most AI coding tools are agent-first: the LLM drives the experience and the shell is bolted on. That means no real PTY, no job control, no interactive commands, and fragile `cd` tracking that reimplements what bash gives you for free.

agent-sh starts from the opposite end. The shell is the primary interface — it's your terminal, not the agent's. The agent is a tool you reach for when you need it, not the other way around.

### Why ACP?

The [Agent Client Protocol](https://agentclientprotocol.com/) decouples the shell from any specific agent:

- **Pluggable agents** — swap between pi-acp, claude-code, codex with a CLI flag
- **Standard protocol** — JSON-RPC 2.0 over stdio, well-specified capability negotiation
- **Agent handles LLM details** — no API keys, tool definitions, or context windows to manage
- **Terminal delegation** — ACP defines `terminal/create`, `terminal/output`, `terminal/wait_for_exit` — exactly what an agent needs to run commands in your shell

## Key Features

- **Instant Start** — Shell starts immediately, no waiting for agent connection
- **Smart Connection** — Agent connects asynchronously in the background
- **Auto-Wait** — Queries automatically wait for agent to finish connecting
- **Real-time Streaming** — Agent responses stream live with syntax highlighting
- **Zero Latency** — Direct PTY access, full terminal compatibility
- **Context Aware** — Agent sees your cwd, recent commands, and their output
- **Multiple Agents** — Easy switching between pi-acp, claude, and other ACP agents
- **Inline Diff Preview** — File writes show syntax-highlighted diffs inline (Ctrl+O to expand)
- **Thinking Display** — Toggle agent thinking/reasoning text with Ctrl+T
- **Themeable** — Semantic color palette, swappable via [extensions](docs/extensions.md)

## Quick Start

```bash
# 1. Install agent-sh and an ACP-compatible agent
npm install -g agent-sh pi-acp

# 2. Set API keys
export ANTHROPIC_API_KEY="your-key"

# 3. Start
agent-sh                           # default agent (pi-acp)
agent-sh --agent claude-agent-acp  # use a different agent
```

Requires Node.js 18+. Other ACP agents: `npm install -g @agentclientprotocol/claude-agent-acp`

> **Note**: The `claude` CLI tool (Claude Code) does **not** support ACP. Use `claude-agent-acp` or `pi-acp` with Anthropic models.

See the [Usage Guide](docs/usage.md) for all options, model configuration, and environment variables.

## Input Modes

| Input | Behavior |
|---|---|
| `ls -la` | Runs in real shell (PTY), output displayed normally |
| `cd src && make` | Real shell — cd, env, aliases all just work |
| `vim file.ts` | Opens vim in the same PTY, no hacks needed |
| `> refactor this fn` | Sends to agent via ACP, streams response inline |
| `> /help` | Shows available slash commands |
| `Ctrl-C` | Standard signal to shell, or cancels active agent response |
| `Ctrl-O` | Expand/collapse truncated diff preview |
| `Ctrl-T` | Toggle thinking/reasoning text display |
| `Escape` | Exit agent input mode (when typing after `>`) |

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Start a new agent session |
| `/copy` | Copy last agent response to clipboard |
| `/compact` | Ask agent to summarize the conversation |
| `/quit` | Exit agent-sh |

## Development

```bash
npm run dev                        # development mode (no build step)
npm run build                      # build
npm start                          # run built version
DEBUG=1 npm start                  # debug mode (logs ACP protocol details)
```

## Documentation

- [Usage Guide](docs/usage.md) — models, providers, API keys, environment config
- [Architecture](docs/architecture.md) — design philosophy, protocol details, project structure
- [Extensions](docs/extensions.md) — writing extensions, theming, yolo mode
- [Library Usage](docs/library.md) — using agent-sh as a Node.js library
- [Troubleshooting](docs/troubleshooting.md) — common errors and debug mode

## License

MIT
