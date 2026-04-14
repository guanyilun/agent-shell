# Architecture

agent-sh is a shell with a pluggable AI backend. The shell is the product — the agent is a bus-driven component that self-wires to events.

## Design Philosophy: Pure Kernel + Everything Is an Extension

The core (`createCore()`) is a frontend-agnostic kernel — it wires up the EventBus, ContextManager, HandlerRegistry, and Compositor with zero knowledge of terminals, PTYs, LLMs, or rendering. **The core has no agent and no LLM client.** The built-in agent backend, provider management, TUI rendering, and all other features are loaded as extensions.

```
createCore() — pure kernel:
  │     EventBus          — typed pub/sub + transform pipelines
  │     ContextManager    — exchange recording, context assembly
  │     HandlerRegistry   — named function registry (define/advise/call)
  │     Compositor        — routes named render streams to surfaces
  │     Multi-backend     — coordinates which agent backend is active
  │
index.ts — interactive terminal frontend:
  │     Shell             — PTY lifecycle (delegates to InputHandler + OutputParser)
  │
  ├── Built-in extensions (loaded via declarative manifest, individually disableable):
  │     agent-backend     — LLM provider resolution, LlmClient, AgentLoop ("ash" backend)
  │     tui-renderer      — markdown rendering, inline diffs, thinking display, spinner
  │     slash-commands    — /help, /model, /thinking, /compact, /context
  │     file-autocomplete — @ file path completion
  │     shell-recall      — shell_recall terminal interception
  │     command-suggest   — fix suggestions on failed commands (fast-path LLM)
  │     terminal-buffer   — terminal_read + terminal_keys tools
  │     overlay-agent     — Ctrl+\ floating overlay agent
  │
  ├── Shared utilities:
  │     palette           — semantic color system (accent, success, warning, error, muted)
  │     diff-renderer     — syntax-highlighted diffs (split/unified/summary)
  │     box-frame         — bordered TUI panels
  │     tool-display      — width-adaptive tool call rendering + pure spinner
  │     output-writer     — OutputWriter interface (StdoutWriter, BufferWriter for tests)
  │     stream-transform  — content block transforms for response pipeline
  │
  └── User extensions (opt-in, loaded from -e flag / settings.json / extensions dir):
        e.g. interactive-prompts, solarized-theme, latex-images, peer-mesh
```

All components communicate exclusively through typed bus events. The backend has no reference to Shell — it emits lifecycle events and the TUI subscribes. Input flows the same way: any frontend emits `agent:submit` and the backend handles it.

Built-in extensions are loaded from a declarative manifest and can be individually disabled via the `disabledBuiltins` setting in `~/.agent-sh/settings.json`. This means even the built-in agent can be disabled (e.g., for users who only use extension backends like Claude Code).

**The core works without any frontend.** See [Library](library.md) for embedding agent-sh in your own apps.

## How It Works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config) and sets up raw stdin passthrough
2. Built-in extensions load (including the agent backend, which registers via `agent:register-backend`), then user extensions
3. `activateBackend()` wires the chosen backend to bus events
4. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
4. When you type `>` at the start of a line, agent-sh intercepts and enters agent input mode
5. On Enter, the query is emitted as `agent:submit` and the agent decides which tools to use
6. The backend handles the query — streaming LLM responses, executing tools, emitting events. Read-only tools run in parallel; permission-requiring tools run sequentially.
7. The TUI renderer extension renders streamed content inline (markdown, diffs, tool calls with tree-style grouping)
8. When the backend finishes (`agent:processing-done`), normal shell operation resumes

## Shell ↔ Agent Boundary

The shell and the agent are **separate worlds** by default. The PTY runs your real shell; the agent runs its tools in isolated child processes. A `cd` by the agent's `bash` tool doesn't change your shell's cwd.

The connection between them is **context**: each query includes shell context (recent commands, output, cwd). The agent sees what you've been doing but can't touch your shell state — unless it uses `user_shell`.

### user_shell & display — The Bridge

Two tools cross the shell↔agent boundary via `shell:exec-request`:

- **`user_shell`** — for commands with lasting effects (`cd`, `export`, `source`, `npm install`). Output goes to the user's terminal; the agent gets `"Command executed"` by default (set `return_output=true` to inspect).
- **`display`** — for read-only display (`cat`, `git log`, `diff`). Output goes to the user's terminal; the agent gets `"Output displayed to user."` — it never sees the content.

Both write commands to the actual PTY via the same bus event:

```
agent calls user_shell({ command: "cd src" })
  → bus.emitPipeAsync("shell:exec-request", { command })
    → Shell writes command to PTY
      → PTY executes in user's real shell
        → shell:command-done fires with output
          → result returned to agent
```

With the internal agent, both are built-in tools. Extension backends can implement them however they choose — see [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends).

## Agent Backend

The agent backend is a bus-driven component that registers via `agent:register-backend`. The core's multi-backend coordinator manages which backend is active — it has no knowledge of any specific backend's internals.

### Internal Agent (AgentLoop)

The default backend, loaded as a built-in extension (`src/extensions/agent-backend.ts`). It resolves LLM providers from settings, creates an `LlmClient`, builds the mode list for model cycling, and creates an `AgentLoop` that uses the `openai` SDK to call any OpenAI-compatible API. See [Internal Agent](agent.md) for the full guide.

The agent-backend extension also exposes the `LlmClient` via the handler registry (`llm:get-client`) so other extensions (like `command-suggest`) can make fast-path LLM calls.

### Extension Backends

Extensions can register alternative backends by emitting `agent:register-backend` during activation — this is the same mechanism the built-in agent uses. See [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for the full protocol and a working example.

All backends emit the same bus events. The TUI, extensions, and library consumers don't know which backend is active.

## Key Extension Points

The extension system provides several composable primitives for customizing agent-sh. Each is documented in detail in the [Extensions](extensions.md) guide:

- **[Event Bus](extensions.md#event-bus)** — typed pub/sub (`on`/`emit`), synchronous transform chains (`onPipe`/`emitPipe`), async transform chains (`onPipeAsync`/`emitPipeAsync`), and transform-then-notify (`emitTransform`)
- **[Custom Agent Backends](extensions.md#custom-agent-backends)** — replace the entire agent backend via `agent:register-backend`
- **[Named Handlers](extensions.md#named-handlers-advice-system)** — `define`/`advise`/`call` registry for wrapping processing steps (e.g. code block rendering)
- **[Content Transform Pipeline](extensions.md#content-transform-pipeline)** — typed content blocks (`text`, `code-block`, `image`, `raw`) flow through parsers and post-transforms before rendering
- **[Custom Input Modes](extensions.md#custom-input-modes)** — register trigger characters (`?`, `>`, etc.) with custom `onSubmit` handlers
- **[Terminal Buffer & Floating Panel](extensions.md#terminal-buffer--floating-panel)** — headless xterm.js terminal mirror + composited overlay with handler-based rendering customization
- **[Theming](extensions.md#theming)** — semantic color palette overrides via `setPalette()`

## Project Structure

```
agent-sh/
├── src/
│   ├── index.ts              # Interactive terminal entry point (CLI args, Shell, extensions)
│   ├── core.ts               # createCore() — pure kernel (no LLM, no agent)
│   ├── event-bus.ts          # Typed EventBus: emit/on, emitPipe, emitPipeAsync, emitTransform
│   ├── context-manager.ts    # Shell exchange log, context assembly, recall API
│   ├── settings.ts           # User settings (~/.agent-sh/settings.json)
│   ├── extension-loader.ts   # Extension loading (-e, settings.json, extensions dir)
│   ├── executor.ts           # Isolated child process execution (shared by shell + bash tool)
│   ├── types.ts              # Shared type definitions
│   │
│   ├── shell/                # Interactive terminal frontend (PTY, input, output)
│   │   ├── shell.ts          # PTY lifecycle + wiring (InputHandler + OutputParser)
│   │   ├── input-handler.ts  # Keyboard input, agent mode, bus-driven autocomplete
│   │   └── output-parser.ts  # OSC parsing, command boundary detection
│   │
│   ├── agent/                # Agent subsystem (used by agent-backend extension)
│   │   ├── types.ts          # AgentBackend, ToolDefinition, ToolResult
│   │   ├── agent-loop.ts     # Internal agent (OpenAI-compat API, bus-driven)
│   │   ├── token-budget.ts   # Unified token budget (splits context window between streams)
│   │   ├── tool-registry.ts  # Map-based tool registry
│   │   ├── conversation-state.ts  # Three-tier conversation: active + nuclear + history
│   │   ├── nuclear-form.ts   # Nuclear one-liner generation + serialization
│   │   ├── history-file.ts   # Persistent JSONL history file
│   │   ├── system-prompt.ts  # System prompt builder
│   │   └── tools/            # Built-in tool implementations
│   │       ├── bash.ts, read-file.ts, write-file.ts, edit-file.ts
│   │       ├── grep.ts, glob.ts, ls.ts, user-shell.ts, display.ts
│   │
│   ├── utils/                # Shared primitives
│   │   ├── llm-client.ts     # OpenAI SDK wrapper
│   │   ├── handler-registry.ts # Named function registry (define/advise/call)
│   │   ├── terminal-buffer.ts  # Headless xterm.js mirror of the terminal
│   │   ├── floating-panel.ts   # Composited floating overlay with handler-based rendering
│   │   ├── compositor.ts       # Routes named render streams to surfaces
│   │   ├── palette.ts, ansi.ts, diff.ts, diff-renderer.ts
│   │   ├── box-frame.ts, tool-display.ts, output-writer.ts
│   │   ├── stream-transform.ts, markdown.ts, file-watcher.ts
│   │   └── line-editor.ts, frame-renderer.ts
│   │
│   └── extensions/           # Built-in extensions (loaded via manifest, disableable)
│       ├── index.ts          # Declarative manifest + loader
│       ├── agent-backend.ts  # LLM provider resolution + AgentLoop registration
│       ├── tui-renderer.ts, slash-commands.ts
│       ├── file-autocomplete.ts, shell-recall.ts
│       ├── command-suggest.ts
│       ├── terminal-buffer.ts  # terminal_read + terminal_keys tools
│       └── overlay-agent.ts    # Ctrl+\ floating overlay agent
│
├── examples/                 # Example extensions and agent integrations
│   └── extensions/
│       ├── peer-mesh.ts      # Cross-instance communication (Ray-inspired)
│       ├── tmux-pane.ts      # Tmux side pane output/interactive modes
│       ├── claude-code-bridge/  # Claude Code SDK backend
│       └── pi-bridge/          # Pi agent backend
├── docs/                     # Documentation
├── package.json
└── tsconfig.json
```
