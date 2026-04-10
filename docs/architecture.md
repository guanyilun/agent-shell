# Architecture

agent-sh is an ACP **client**. The agent is a subprocess launched with stdio transport.

## Design Philosophy: Headless Core + Pluggable Frontends

The core (`createCore()`) is a frontend-agnostic kernel — it wires up the EventBus, ContextManager, and AcpClient with zero knowledge of terminals, PTYs, or rendering. The interactive terminal (Shell + TUI + extensions) is one frontend built on top.

```
createCore() — frontend-agnostic kernel:
  │     EventBus          — typed pub/sub + transform pipelines
  │     ContextManager    — exchange recording, context assembly
  │     AcpClient         — ACP protocol, terminal execution (yolo by default)
  │
index.ts — interactive terminal frontend:
  │     Shell             — PTY lifecycle (delegates to InputHandler + OutputParser)
  │
  ├── Built-in extensions:
  │     tuiRenderer       — markdown rendering, inline diffs, thinking display, spinner
  │     slashCommands     — /help, /clear, /copy, /compact, /quit
  │     fileAutocomplete  — @ file path completion
  │     shellRecall       — shell_recall terminal interception
  │
  ├── Shared utilities:
  │     palette           — semantic color system (accent, success, warning, error, muted)
  │     diff-renderer     — syntax-highlighted diffs (split/unified/summary)
  │     box-frame         — bordered TUI panels
  │     tool-display      — width-adaptive tool call rendering
  │
  └── User extensions (opt-in, loaded from -e flag / settings.json / extensions dir):
        e.g. interactive-prompts, solarized-theme
```

All components communicate exclusively through typed bus events. AcpClient has no reference to Shell — it emits lifecycle events (`agent:processing-start`, `agent:processing-done`) and Shell subscribes to manage its own state. Input flows the same way: any frontend emits `agent:submit` and the core routes it to the agent.

**The core works without any frontend.** This enables:

- **Library usage** — `import { createCore } from "agent-sh"` to build WebSocket servers, REST APIs, Electron apps, or test harnesses
- **Headless mode** — CI, scripting, embedding — no terminal needed
- **Alternative renderers** — web UI, logging backend, minimal TUI
- **Custom features** — add commands, autocomplete providers, tool interceptors by writing an extension

## Protocol

### We send to the agent

| Method | When |
|---|---|
| `initialize` | Startup: negotiate capabilities |
| `session/new` | Create a conversation session (returns available modes) |
| `session/prompt` | User types `> query` — sent with shell context |
| `session/cancel` | User hits Ctrl-C during agent response |
| `session/set_mode` | Cycle thinking level (Shift-Tab) — e.g. off/low/medium/high |

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
| `agent_message_chunk` | Real-time streaming markdown with syntax highlighting in a bordered box |
| `agent_thought_chunk` | Thinking spinner (default), or streaming text when toggled on with Ctrl+T. Spinner shows "Working" when thinking mode is off |
| `current_mode_update` | Updates the thinking level indicator in the prompt |
| `tool_call` | Kind icon (◆ read, ✎ edit, ▶ execute, ⌕ search, etc.) + title, file paths, arguments |
| `tool_call_update` | Streaming output content + status indicator (checkmark or X with exit code) |
| `file_write` | Inline diff preview in bordered box (Ctrl+O to expand/collapse) |

## How It Works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config — oh-my-zsh, p10k, aliases, plugins, PATH) and sets up raw stdin passthrough
2. It launches the specified ACP agent as a subprocess with stdio transport
3. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
4. **Smart connection**: The agent connects asynchronously in the background while the shell starts immediately
5. **Auto-wait**: If you send a query before the agent is fully connected, the system automatically waits for connection completion
6. When you type `>` at the start of a line, agent-sh intercepts and enters agent input mode (with Shift-Enter for multiline, Shift-Tab to cycle thinking level)
7. On Enter, the query (plus shell context) is sent to the agent via `session/prompt`
8. The agent's streaming response renders inline in a bordered markdown box with real-time output
9. If the agent needs to run commands, it calls `terminal/create` and agent-sh executes them in isolated child processes, streaming output back
10. When the agent finishes, normal shell operation resumes

## Shell ↔ Agent Boundary

The shell and the agent are **separate worlds** by default. The PTY runs your real shell; the agent runs as an isolated subprocess with its own tools (bash, file read/write, etc.). They don't directly interact — the agent's `bash` tool runs commands in an isolated child process, not your live shell. A `cd` by the agent doesn't change your shell's cwd.

The connection between them is **context**: each time you send a query (`> ...`), agent-sh includes a `<shell_context>` block with your recent commands, their output, and your current working directory. The agent can see what you've been doing, but it can't touch your shell state.

### Bridge tools

For cases where the agent *should* affect the live shell (e.g., `cd`, `export`, `source`), agent-sh provides bridge tools via a Unix domain socket:

| Tool | Purpose |
|---|---|
| `shell_cwd` | Query the user's real shell cwd (may differ from agent's internal cwd) |
| `user_shell` | Execute a command in the user's live PTY — `cd`, `export`, etc. take effect |
| `shell_recall` | Search, expand, or browse session history (commands, output, agent responses) |

These tools are **not built into the agent** — they're registered externally and the agent discovers them at session start. This keeps the architecture clean: the agent doesn't need to know about agent-sh specifically.

### How agents discover bridge tools

Two paths to the same socket backend — **both always active**:

1. **MCP server** (on by default) — the shell-exec extension registers an MCP server via the `session:configure` pipe when creating an ACP session. Any ACP agent that forwards `mcpServers` (like claude-agent-acp) discovers `shell_cwd`, `user_shell`, and `shell_recall` tools automatically. Agents that don't support MCP (like pi-acp) simply ignore it. Can be disabled via `"enableMcp": false` in settings.json.

2. **Agent extensions** (agent-specific) — some agents don't support MCP but have their own extension system. For pi-acp, the pi extension (`examples/pi-agent-sh.ts`, installed to `~/.pi/agent/extensions/pi-agent-sh/`) reads `AGENT_SH_SOCKET` from the environment and connects to the same socket directly.

Both paths connect to the same Unix socket (`$AGENT_SH_SOCKET`), which speaks JSON-RPC 2.0. The shell-exec extension handles requests by routing them through the EventBus — it never touches the PTY directly.

```
Agent (pi, claude, etc.)
  │
  ├── via MCP server (stdio) ──┐
  │                             ├──→ Unix socket ($AGENT_SH_SOCKET)
  └── via agent extension ─────┘         │
                                    shell-exec extension
                                         │ EventBus
                                    Shell (PTY write + output capture)
```

### Pi extension example

The reference implementation lives at `examples/pi-agent-sh.ts`. It registers all three bridge tools with pi's extension API and communicates with agent-sh via the socket:

```typescript
// Simplified — see examples/pi-agent-sh.ts for full source
pi.registerTool({
  name: "user_shell",
  description: "Execute a command in the user's live terminal session...",
  async execute(_id, params) {
    const result = await callSocket("shell/exec", { command: params.command });
    return { content: [{ type: "text", text: result.output }] };
  },
});
```

To install for pi:
```bash
mkdir -p ~/.pi/agent/extensions/pi-agent-sh
cp examples/pi-agent-sh.ts ~/.pi/agent/extensions/pi-agent-sh/index.ts
```

### Writing your own bridge client

Any process can connect to the socket. The protocol is JSON-RPC 2.0 (newline-delimited):

```bash
# Quick test (requires socat)
echo '{"jsonrpc":"2.0","id":1,"method":"shell/cwd","params":{}}' | \
  socat - UNIX-CONNECT:$AGENT_SH_SOCKET
```

## Socket Protocol

The Unix socket speaks **JSON-RPC 2.0** (newline-delimited).

### Methods

| Method | Params | Result | Description |
|---|---|---|---|
| `shell/exec` | `{ command }` | `{ output, cwd }` | Execute command in the user's PTY, capture output |
| `shell/cwd` | `{}` | `{ cwd }` | Get current working directory |
| `shell/info` | `{}` | `{ shell, agentSh }` | Get shell metadata |
| `shell/recall` | `{ operation, query?, ids?, start?, end? }` | `{ result }` | Search, expand, or browse session exchange history |

The socket path is available via the `AGENT_SH_SOCKET` environment variable. The protocol is extensible — new methods can be added without breaking existing clients.

## EventBus

All communication between components flows through a typed EventBus. Components emit events (shell commands, agent responses, tool calls) and extensions subscribe to events they care about. The bus supports four modes:

- **emit/on** — fire-and-forget notifications (e.g., `shell:command-done`)
- **emitPipe/onPipe** — synchronous transform chains (e.g., `autocomplete:request` where extensions append completion items, `session:configure` where extensions add MCP servers)
- **emitPipeAsync/onPipeAsync** — async transform chains (e.g., `permission:request` where extensions prompt the user and return a decision, `shell:exec-request` where Shell executes a command in the PTY)
- **emitTransform** — transform-then-notify: runs pipe listeners to transform the payload, then emits the result to `on` listeners. Used for content streams where extensions can modify data before renderers see it.

### Content Transform Pipeline

Agent content streams (`agent:response-chunk`, `agent:thinking-chunk`, `agent:tool-output-chunk`) use `emitTransform`. This creates a two-phase flow:

```
AcpClient
  → emitTransform("agent:response-chunk", { text })
      Phase 1 (onPipe): transform extensions modify text
        → latex-ext:    $E=mc^2$ → terminal image escape sequence
        → diagram-ext:  ```mermaid → rendered diagram
        → any extension can register here
      Phase 2 (on): renderers see the final transformed text
        → tui-renderer renders to terminal
        → web-renderer renders to HTML
        → logger captures for debugging
```

Transform extensions register with `bus.onPipe("agent:response-chunk", ...)` and modify the payload. Renderers register with `bus.on("agent:response-chunk", ...)` and consume the final result. Since `onPipe` runs first, transforms always complete before any renderer sees the content.

This means the tui-renderer is just an extension — it has no privileged access to content. A LaTeX extension, a syntax highlighter, or a diagram renderer all compose through the same bus, and any renderer (terminal, web, log) sees the same transformed output.

### Streaming Transforms

Agent responses arrive as a stream of small chunks. A pattern like `$E=mc^2$` may span multiple chunks. Transform extensions handle this by **buffering** — holding back text until a pattern is complete, and releasing the safe portion:

```
chunk 1: "The energy is $E=mc"    → release "The energy is ", hold "$E=mc"
chunk 2: "^2$ which means"        → transform "$E=mc^2$", release result + " which means"
```

The pipe supports this naturally — the extension returns only the ready-to-render portion and keeps a buffer internally. On `agent:response-done` (also piped via `emitTransform`), extensions flush any remaining buffered text.

```typescript
// Streaming transform skeleton
let buf = "";

bus.onPipe("agent:response-chunk", (e) => {
  buf += e.text;
  const { ready, pending } = splitAtSafeBoundary(buf, /\$[^$]*\$/);
  buf = pending;
  return { ...e, text: ready };
});

bus.onPipe("agent:response-done", (e) => {
  if (buf) {
    // Pattern never closed — flush raw text
    bus.emitTransform("agent:response-chunk", { text: buf });
    buf = "";
  }
  return e;
});
```

Events using `emitTransform`: `agent:response-chunk`, `agent:thinking-chunk`, `agent:tool-output-chunk`, `agent:response-done`.

## Project Structure

```
agent-sh/
├── src/
│   ├── index.ts            # Interactive terminal entry point (CLI args, Shell, extensions)
│   ├── core.ts             # createCore() — frontend-agnostic kernel, library entry point
│   ├── event-bus.ts        # Typed EventBus: emit/on, emitPipe, emitPipeAsync
│   ├── shell.ts            # PTY lifecycle + wiring (InputHandler + OutputParser)
│   ├── input-handler.ts    # Keyboard input, agent mode, bus-driven autocomplete
│   ├── output-parser.ts    # OSC parsing, command boundary detection
│   ├── acp-client.ts       # ACP protocol, terminal execution, session management
│   ├── context-manager.ts  # Exchange log, context assembly, recall API
│   ├── settings.ts         # User settings (~/.agent-sh/settings.json)
│   ├── extension-loader.ts # Extension loading (-e, settings.json, extensions dir)
│   ├── executor.ts         # Isolated child process execution
│   ├── mcp-server.ts       # Standalone MCP server (shell_cwd, user_shell, shell_recall via socket)
│   ├── types.ts            # Shared type definitions
│   ├── utils/
│   │   ├── palette.ts      # Semantic color palette (accent/success/warning/error/muted)
│   │   ├── ansi.ts         # ANSI utility functions (visibleLen, stripAnsi)
│   │   ├── diff.ts         # Line-level LCS diff for file change previews
│   │   ├── diff-renderer.ts# Syntax-highlighted diff display (split/unified/summary)
│   │   ├── box-frame.ts    # Bordered TUI panels (rounded/square/double/heavy)
│   │   ├── tool-display.ts # Width-adaptive tool call/result rendering
│   │   ├── line-editor.ts  # Readline-style line editor (pure logic, no I/O)
│   │   ├── file-watcher.ts # File change detection for agent tool writes
│   │   └── markdown.ts     # Streaming markdown → ANSI renderer
│   └── extensions/
│       ├── tui-renderer.ts       # Terminal rendering (markdown, spinner, tools)
│       ├── slash-commands.ts     # /help, /clear, /copy, /compact, /quit
│       ├── file-autocomplete.ts  # @ file path completion
│       ├── shell-recall.ts      # shell_recall terminal interception
│       └── shell-exec.ts       # Unix socket server + MCP registration for PTY exec
├── examples/
│   ├── pi-agent-sh.ts              # Pi extension: shell_cwd, user_shell, shell_recall tools
│   └── extensions/
│       ├── interactive-prompts.ts   # Example: permission gates (opt-in)
│       └── solarized-theme.ts      # Example: color theme via setPalette()
├── package.json
└── tsconfig.json
```
