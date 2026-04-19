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
  │     slash-commands    — /help, /model, /backend, /thinking, /compact, /context, /reload
  │     file-autocomplete — @ file path completion
  │     command-suggest   — fix suggestions on failed commands (fast-path LLM)
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
        e.g. overlay-agent, interactive-prompts, solarized-theme, latex-images, peer-mesh
```

All components communicate exclusively through typed bus events. The backend has no reference to Shell — it emits lifecycle events and the TUI subscribes. Input flows the same way: any frontend emits `agent:submit` and the backend handles it.

Built-in extensions are loaded from a declarative manifest and can be individually disabled via the `disabledBuiltins` setting in `~/.agent-sh/settings.json`. This means even the built-in agent can be disabled (e.g., for users who only use extension backends like Claude Code).

**The core works without any frontend.** See [Library](library.md) for embedding agent-sh in your own apps.

## How It Works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config) and sets up raw stdin passthrough
2. Built-in extensions load (including the agent backend, which registers via `agent:register-backend`), then user extensions
3. `activateBackend()` wires the chosen backend to bus events
4. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
5. When you type `>` at the start of a line, agent-sh intercepts and enters agent input mode
6. On Enter, the query is emitted as `agent:submit` and the active backend decides which tools to use
7. The backend handles the query — streaming LLM responses, executing tools, emitting events. Read-only tools run in parallel; permission-requiring tools run sequentially.
8. The TUI renderer extension renders streamed content inline (markdown, diffs, tool calls with tree-style grouping)
9. When the backend finishes (`agent:processing-done`), normal shell operation resumes

## Shell ↔ Agent Boundary

The shell and the agent are **separate worlds** by default. The PTY runs your real shell; the agent runs its tools in isolated child processes. A `cd` by the agent's `bash` tool doesn't change your shell's cwd.

The connection between them is **context**: each query includes shell context (recent commands, output, cwd). The agent sees what you've been doing but can't touch your shell state.

Extensions can cross this boundary using `shell:exec-request`. The core event bus makes this easy to wire up — an extension just registers a tool that emits the event and returns the result. We don't include a PTY tool as built-in because the right behavior depends on user preference (confirmation prompts? output capture? restricted commands?). See the `user_shell` example in `examples/extensions/` for a ready-made implementation.

The pattern works like this:

```
agent calls user_shell({ command: "cd src" })
  → bus.emitPipeAsync("shell:exec-request", { command })
    → Shell writes command to PTY
      → PTY executes in user's real shell
        → shell:command-done fires with output
          → result returned to agent
```

## Agent Backend

The agent backend is a bus-driven component that registers via `agent:register-backend`. The core's multi-backend coordinator manages which backend is active — it has no knowledge of any specific backend's internals.

### Built-in backend: ash

The default backend is **ash**, loaded as a built-in extension (`src/extensions/agent-backend.ts`). It resolves LLM providers from settings, creates an `LlmClient`, builds the mode list for runtime model switching, and creates an `AgentLoop` that uses the `openai` SDK to call any OpenAI-compatible API. See [The Built-in Agent: ash](agent.md) for the full guide.

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
│   │   ├── agent-loop.ts     # ash backend (OpenAI-compat API, bus-driven)
│   │   ├── token-budget.ts   # Shared constants (RESPONSE_RESERVE, DEFAULT_CONTEXT_WINDOW)
│   │   ├── tool-registry.ts  # Map-based tool registry
│   │   ├── tool-protocol.ts  # Tool calling protocol abstraction (api/deferred/inline)
│   │   ├── conversation-state.ts  # Messages + eager nucleation + three-tier priority compaction + recall
│   │   ├── nuclear-form.ts   # One-line-summary primitives (nucleate, serialize, priority)
│   │   ├── history-file.ts   # Persistent JSONL at ~/.agent-sh/history (append-only, concurrent-safe)
│   │   ├── system-prompt.ts  # System prompt builder
│   │   ├── skills.ts         # Skill discovery and loading
│   │   ├── subagent.ts       # Subagent orchestration
│   │   └── tools/            # Built-in tool implementations
│   │       ├── bash.ts, read-file.ts, write-file.ts, edit-file.ts
│   │       ├── grep.ts, glob.ts, ls.ts
│   │       └── list-skills.ts
│   │
│   ├── utils/                # Shared primitives
│   │   ├── llm-client.ts     # OpenAI SDK wrapper
│   │   ├── handler-registry.ts # Named function registry (define/advise/call)
│   │   ├── terminal-buffer.ts  # Headless xterm.js mirror of the terminal
│   │   ├── floating-panel.ts   # Composited floating overlay with handler-based rendering
│   │   ├── compositor.ts       # Routes named render streams to surfaces
│   │   ├── shell-output-spill.ts # Session-tempfile spill for long shell outputs
│   │   ├── package-version.ts  # PACKAGE_VERSION constant read from package.json
│   │   ├── palette.ts, ansi.ts, diff.ts, diff-renderer.ts
│   │   ├── box-frame.ts, tool-display.ts, output-writer.ts
│   │   ├── stream-transform.ts, markdown.ts, file-watcher.ts
│   │   ├── line-editor.ts, frame-renderer.ts
│   │   └── message-utils.ts, tool-interactive.ts
│   │
│   └── extensions/           # Built-in extensions (loaded via manifest, disableable)
│       ├── index.ts          # Declarative manifest + loader
│       ├── agent-backend.ts  # LLM provider resolution + AgentLoop registration
│       ├── tui-renderer.ts, slash-commands.ts
│       ├── file-autocomplete.ts
│       └── command-suggest.ts
│
├── examples/                 # Example extensions and agent integrations
│   └── extensions/
│       ├── overlay-agent.ts     # Ctrl+\ floating overlay agent
│       ├── interactive-prompts.ts # Permission prompts (opt-in safety)
│       ├── peer-mesh.ts         # Cross-instance communication
│       ├── terminal-buffer.ts   # Headless xterm.js terminal mirror extension
│       ├── tmux-pane.ts         # Tmux side pane output/interactive modes
│       ├── web-access.ts        # Web search and content extraction
│       ├── user-shell.ts        # Run commands in the live PTY
│       ├── questionnaire.ts     # Interactive question prompts
│       ├── subagents.ts         # Subagent orchestration
│       ├── solarized-theme.ts   # Theme example
│       ├── secret-guard.ts      # Secret redaction
│       ├── latex-images.ts      # LaTeX equation rendering
│       ├── openrouter.ts        # OpenRouter provider helper
│       ├── claude-code-bridge/  # Claude Code SDK backend
│       ├── pi-bridge/           # Pi agent backend
│       ├── ash-mcp-bridge/      # MCP server bridge
│       └── ash-acp-bridge/      # ACP server (headless core)
├── docs/                     # Documentation
├── package.json
└── tsconfig.json
```
