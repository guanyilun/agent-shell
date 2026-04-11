# Architecture

agent-sh is a shell with a pluggable AI backend. The shell is the product — the agent is a bus-driven component that self-wires to events.

## Design Philosophy: Headless Core + Pluggable Backends

The core (`createCore()`) is a frontend-agnostic kernel — it wires up the EventBus, ContextManager, and an AgentBackend with zero knowledge of terminals, PTYs, or rendering. The interactive terminal is one frontend built on top.

```
createCore({ apiKey, baseURL, model }) — frontend-agnostic kernel:
  │     EventBus          — typed pub/sub + transform pipelines
  │     ContextManager    — exchange recording, context assembly
  │     AgentBackend      — bus-driven, self-wiring (AgentLoop or extension-provided)
  │     LlmClient         — shared OpenAI-compat SDK wrapper
  │
index.ts — interactive terminal frontend:
  │     Shell             — PTY lifecycle (delegates to InputHandler + OutputParser)
  │
  ├── Built-in extensions:
  │     tuiRenderer       — markdown rendering, inline diffs, thinking display, spinner
  │     slashCommands     — /help, /clear, /copy, /compact, /quit
  │     fileAutocomplete  — @ file path completion
  │     shellRecall       — shell_recall terminal interception
  │     commandSuggest    — fix suggestions on failed commands (fast-path LLM)
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
        e.g. interactive-prompts, solarized-theme, latex-images
```

All components communicate exclusively through typed bus events. The backend has no reference to Shell — it emits lifecycle events and the TUI subscribes. Input flows the same way: any frontend emits `agent:submit` and the backend handles it.

**The core works without any frontend.** See [Library](library.md) for embedding agent-sh in your own apps.

## How It Works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config) and sets up raw stdin passthrough
2. It creates the agent backend (AgentLoop or extension-provided) which self-wires to bus events
3. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
4. When you type `?` or `>` at the start of a line, agent-sh intercepts and enters an agent input mode
5. On Enter, the query is emitted as `agent:submit` with a mode instruction (`[mode: query]` or `[mode: execute]`)
6. The backend handles the query — streaming LLM responses, executing tools, emitting events
7. The TUI renderer extension renders streamed content inline (markdown, diffs, tool calls)
8. When the backend finishes (`agent:processing-done`), normal shell operation resumes

## Shell ↔ Agent Boundary

The shell and the agent are **separate worlds** by default. The PTY runs your real shell; the agent runs its tools in isolated child processes. A `cd` by the agent's `bash` tool doesn't change your shell's cwd.

The connection between them is **context**: each query includes shell context (recent commands, output, cwd). The agent sees what you've been doing but can't touch your shell state — unless it uses `user_shell`.

### user_shell — The Bridge

For commands that *should* affect the live shell (`cd`, `export`, `source`, user-facing commands), the agent uses `user_shell`. This tool writes the command to the actual PTY via bus events:

```
agent calls user_shell({ command: "cd src" })
  → bus.emitPipeAsync("shell:exec-request", { command })
    → Shell writes command to PTY
      → PTY executes in user's real shell
        → shell:command-done fires with output
          → result returned to agent
```

With the internal agent, `user_shell` is a built-in tool. Extension backends can implement it however they choose — see [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends).

## Agent Backend

The agent backend is a bus-driven component. Core creates it and holds a reference for lifecycle only — all communication flows through events.

### Internal Agent (AgentLoop)

The default backend. Uses the `openai` SDK to call any OpenAI-compatible API directly. See [Internal Agent](agent.md) for the full guide — the query flow, tool loop, context assembly, streaming, and built-in tools.

### Extension Backends

Extensions can replace the built-in backend entirely by emitting `agent:register-backend` during activation. This is how you integrate external agents, custom protocols, or alternative LLM providers that don't follow the OpenAI API. See [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for the full protocol and a working example.

All backends emit the same bus events. The TUI, extensions, and library consumers don't know which backend is active.

## Key Extension Points

The extension system provides several composable primitives for customizing agent-sh. Each is documented in detail in the [Extensions](extensions.md) guide:

- **[Event Bus](extensions.md#event-bus)** — typed pub/sub (`on`/`emit`), synchronous transform chains (`onPipe`/`emitPipe`), async transform chains (`onPipeAsync`/`emitPipeAsync`), and transform-then-notify (`emitTransform`)
- **[Custom Agent Backends](extensions.md#custom-agent-backends)** — replace the entire agent backend via `agent:register-backend`
- **[Named Handlers](extensions.md#named-handlers-advice-system)** — `define`/`advise`/`call` registry for wrapping processing steps (e.g. code block rendering)
- **[Content Transform Pipeline](extensions.md#content-transform-pipeline)** — typed content blocks (`text`, `code-block`, `image`, `raw`) flow through parsers and post-transforms before rendering
- **[Custom Input Modes](extensions.md#custom-input-modes)** — register trigger characters (`?`, `>`, etc.) with custom `onSubmit` handlers
- **[Theming](extensions.md#theming)** — semantic color palette overrides via `setPalette()`

## Project Structure

```
agent-sh/
├── src/
│   ├── index.ts            # Interactive terminal entry point (CLI args, Shell, extensions)
│   ├── core.ts             # createCore() — frontend-agnostic kernel, library entry point
│   ├── event-bus.ts        # Typed EventBus: emit/on, emitPipe, emitPipeAsync, emitTransform
│   ├── shell.ts            # PTY lifecycle + wiring (InputHandler + OutputParser)
│   ├── input-handler.ts    # Keyboard input, agent mode, bus-driven autocomplete
│   ├── output-parser.ts    # OSC parsing, command boundary detection
│   ├── context-manager.ts  # Exchange log, context assembly, recall API
│   ├── settings.ts         # User settings (~/.agent-sh/settings.json)
│   ├── extension-loader.ts # Extension loading (-e, settings.json, extensions dir)
│   ├── executor.ts         # Isolated child process execution (shared by shell + bash tool)
│   ├── types.ts            # Shared type definitions
│   │
│   ├── agent/              # Agent backends (behind AgentBackend interface)
│   │   ├── types.ts        # AgentBackend, ToolDefinition, ToolResult
│   │   ├── index.ts        # Factory: config → AgentLoop
│   │   ├── agent-loop.ts   # Internal agent (OpenAI-compat API, bus-driven)
│   │   ├── tool-registry.ts       # Map-based tool registry
│   │   ├── conversation-state.ts  # OpenAI chat messages array
│   │   ├── system-prompt.ts       # System prompt builder
│   │   └── tools/          # Built-in tool implementations
│   │       ├── bash.ts, read-file.ts, write-file.ts, edit-file.ts
│   │       ├── grep.ts, glob.ts, ls.ts, user-shell.ts
│   │
│   ├── utils/              # Shared primitives
│   │   ├── llm-client.ts   # OpenAI SDK wrapper (shared by agent loop + extensions)
│   │   ├── palette.ts, ansi.ts, diff.ts, diff-renderer.ts
│   │   ├── box-frame.ts, tool-display.ts, output-writer.ts
│   │   ├── stream-transform.ts, markdown.ts, file-watcher.ts
│   │   └── line-editor.ts, frame-renderer.ts
│   │
│   └── extensions/         # Built-in extensions
│       ├── tui-renderer.ts, slash-commands.ts
│       ├── file-autocomplete.ts, shell-recall.ts
│       ├── shell-exec.ts, command-suggest.ts
│
├── examples/               # Example extensions and agent integrations
├── docs/                   # Documentation
├── package.json
└── tsconfig.json
```
