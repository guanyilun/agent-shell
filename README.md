# agent-shell

A real shell where an LLM agent is one keystroke away.

Regular input runs as shell commands in a true PTY. Lines starting with `>` are sent to an AI agent via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). The agent has full context of your shell session — working directory, recent commands, last output — and can run commands on your behalf.

The result is a drop-in terminal replacement that works with **any** ACP-compatible agent: [pi](https://github.com/svkozak/pi-acp), claude-code, codex, gemini-cli, goose, etc.

```
⚡ src $ ls -la                          # real shell command
⚡ src $ cd ../tests && npm test          # real cd, env, aliases — all just work
⚡ src $ vim file.ts                      # opens vim in the same PTY
⚡ src $ > refactor the auth middleware   # → sent to agent via ACP
⚡ src $ > explain the last error         # agent sees your recent commands + output
```

## Why?

Most AI coding tools are agent-first: the LLM drives the experience and the shell is an afterthought. That means no real PTY, no job control, no interactive commands, and fragile `cd` tracking.

agent-shell flips the architecture: **shell-first, agent-on-demand**. You get a real terminal with full bash/zsh capabilities, and the agent is available when you need it via a simple `>` prefix.

### Why ACP?

The [Agent Client Protocol](https://agentclientprotocol.com/) decouples the shell from any specific agent:

- **Pluggable agents** — swap between pi, claude-code, codex with a CLI flag
- **Standard protocol** — JSON-RPC 2.0 over stdio, well-specified capability negotiation
- **Agent handles LLM details** — no API keys, tool definitions, or context windows to manage
- **Terminal delegation** — ACP defines `terminal/create`, `terminal/output`, `terminal/wait_for_exit` — exactly what an agent needs to run commands in your shell

## Install

```bash
git clone https://github.com/guanyilun/agent-shell.git
cd agent-shell
npm install
npm run build
```

Requires Node.js 18+ and an ACP-compatible agent installed on your system.

## Usage

```bash
# Start with the default agent (claude)
npx agent-shell

# Start with a specific agent
npx agent-shell --agent pi-acp

# Pass arguments to the agent
npx agent-shell --agent claude --agent-args "--model sonnet"

# Use a different shell
npx agent-shell --shell /bin/zsh
```

### Input modes

| Input | Behavior |
|---|---|
| `ls -la` | Runs in real shell (PTY), output displayed normally |
| `cd src && make` | Real shell — cd, env, aliases all just work |
| `vim file.ts` | Opens vim in the same PTY, no hacks needed |
| `> refactor this fn` | Sends to agent via ACP, streams response inline |
| `> /help` | Shows available slash commands |
| `Ctrl-C` | Standard signal to shell, or cancels active agent response |
| `Escape` | Exit agent input mode (when typing after `>`) |

When you type `>` at the start of a line, agent-shell enters **agent input mode** — the prompt changes to a yellow `❯` and your text is sent to the agent on Enter. The agent's response streams inline in a bordered box with markdown rendering.

### Slash commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Start a new agent session |
| `/copy` | Copy last agent response to clipboard |
| `/compact` | Ask agent to summarize the conversation |
| `/quit` | Exit agent-shell |

Slash commands have tab-completion and arrow-key navigation in agent input mode.

### Shell context

The agent automatically receives context about your shell session with each query:

- **Current working directory** — tracked via OSC 7
- **Recent commands and output** — commands you've run since the last agent interaction, with their output

This means you can run a failing command, then type `> fix this` and the agent knows exactly what happened.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    agent-shell                       │
│                                                     │
│  ┌──────────────┐       ┌────────────────────────┐  │
│  │  Shell Layer  │       │   ACP Client Layer     │  │
│  │              │       │                        │  │
│  │  Real PTY    │       │  Agent subprocess      │  │
│  │  bash under  │◄─────►│  (stdio transport)     │  │
│  │  the hood    │       │                        │  │
│  │              │       │  JSON-RPC 2.0          │  │
│  │  History     │       │                        │  │
│  │  Completion  │       │  terminal/create       │  │
│  │  Job control │       │  fs/read_text_file     │  │
│  │  Signals     │       │  session/update        │  │
│  └──────────────┘       └────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │              TUI / Rendering                   │  │
│  │  Shell output: passthrough (raw terminal)     │  │
│  │  Agent output: bordered box, markdown, syntax │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

agent-shell is an ACP **client**. The agent is a subprocess launched with stdio transport.

### We send to the agent

| Method | When |
|---|---|
| `initialize` | Startup: negotiate capabilities |
| `session/new` | Create a conversation session |
| `session/prompt` | User types `> query` — sent with shell context |
| `session/cancel` | User hits Ctrl-C during agent response |

### We handle from the agent

| Method | What we do |
|---|---|
| `terminal/create` | Execute command in an isolated child process |
| `terminal/output` | Return captured output for a terminal ID |
| `terminal/wait_for_exit` | Await command completion, return exit code |
| `terminal/kill` | Send signal to running command |
| `terminal/release` | Cleanup terminal session |
| `fs/read_text_file` | Read file from disk, return content |
| `fs/write_text_file` | Write file to disk |
| `session/request_permission` | Prompt user for y/n/allow-all confirmation |

### We render from the agent

| Update type | What we render |
|---|---|
| `agent_message_chunk` | Stream markdown with syntax highlighting in a bordered box |
| `tool_call` | Yellow header showing what the agent is invoking |
| `tool_call_update` | Status indicator (✓ or ✗ with exit code) |

## Project structure

```
agent-shell/
├── src/
│   ├── index.ts        # Entry point, CLI arg parsing, wiring
│   ├── shell.ts        # PTY management, input routing, agent input mode
│   ├── acp-client.ts   # ACP connection, request/notification handling
│   ├── executor.ts     # Isolated command execution for terminal/* handlers
│   ├── tui.ts          # Spinner, status, agent output rendering
│   ├── markdown.ts     # Streaming markdown → ANSI renderer with box drawing
│   ├── commands.ts     # Slash command definitions (/help, /clear, /copy, etc.)
│   └── types.ts        # Shared interfaces
├── package.json
└── tsconfig.json
```

## Development

```bash
# Run in development mode (no build step)
npm run dev

# Build
npm run build

# Run the built version
npm start

# Debug mode — logs ACP protocol details to stderr
DEBUG=1 npx agent-shell
```

## How it works

1. agent-shell spawns a real PTY running bash and sets up raw stdin passthrough
2. It launches the specified ACP agent as a subprocess with stdio transport
3. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
4. When you type `>` at the start of a line, agent-shell intercepts and enters agent input mode
5. On Enter, the query (plus shell context) is sent to the agent via `session/prompt`
6. The agent's streaming response renders inline in a bordered markdown box
7. If the agent needs to run commands, it calls `terminal/create` and agent-shell executes them in isolated child processes, streaming output back
8. When the agent finishes, normal shell operation resumes

## License

MIT
