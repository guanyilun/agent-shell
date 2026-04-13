# Extensions

An extension is a module that exports a default (or named `activate`) function. It receives an `ExtensionContext` with access to all core services — no package imports needed.

```typescript
export default function activate(ctx: ExtensionContext) {
  const { bus } = ctx;

  bus.on("agent:response-done", (e) => {
    console.log(`Agent responded with ${e.response.length} chars`);
  });
}
```

## Loading Extensions

Extensions are loaded from three sources (in order, deduplicated):

**CLI flag** (`-e` / `--extensions`):
```bash
npm start -- -e my-ext-package -e ./local-ext.ts
npm start -- -e my-ext-package,another-package   # comma-separated also works
```

**Settings file** (`~/.agent-sh/settings.json`):
```json
{
  "extensions": [
    "my-published-extension",
    "./relative/path/to/ext.ts"
  ]
}
```

**Extensions directory** (`~/.agent-sh/extensions/`):
```
~/.agent-sh/extensions/
├── my-extension.ts          # loaded directly
├── another.js               # JS works too
└── complex-extension/       # directory with index file
    └── index.ts
```

TypeScript and JavaScript are both supported (`.ts`, `.tsx`, `.mts`, `.js`, `.mjs`). TS is transpiled at runtime via tsx. Bare names resolve as npm packages via Node's standard module resolution. Errors in extension loading are non-fatal.

## ExtensionContext API

| Property | Type | Description |
|---|---|---|
| `bus` | `EventBus` | Subscribe to events, emit events, register pipe handlers |
| `contextManager` | `ContextManager` | Access exchange history, cwd, search, expand |
| `llmClient` | `LlmClient \| null` | LLM client for fast-path features (null if extension backend provides its own) |
| `quit` | `() => void` | Exit agent-sh |
| `setPalette` | `(overrides) => void` | Override color palette slots for theming |
| `createBlockTransform` | `(opts) => void` | Register an inline delimiter transform (e.g. `$$...$$`) |
| `createFencedBlockTransform` | `(opts) => void` | Register a fenced block transform (e.g. ` ```lang...``` `) |
| `getExtensionSettings` | `(namespace, defaults) => T` | Read extension settings from `~/.agent-sh/settings.json` |
| `registerTool` | `(tool: ToolDefinition) => void` | Register a tool for the built-in agent (no-op for bridge backends). Tools can include optional `getDisplayInfo`, `formatCall`, and `formatResult` for TUI integration — see [Internal Agent: Tool interface](agent.md#tool-interface) |
| `getTools` | `() => ToolDefinition[]` | Get all registered tools (for subagent tool subsets) |
| `define` | `(name, fn) => void` | Register a named handler |
| `advise` | `(name, wrapper) => void` | Wrap a named handler (receives `next` + args) |
| `call` | `(name, ...args) => any` | Call a named handler |
| `terminalBuffer` | `TerminalBuffer \| null` | Shared headless xterm.js buffer mirroring PTY output (lazy singleton, null if `@xterm/headless` not installed) |
| `createFloatingPanel` | `(config: FloatingPanelConfig) => FloatingPanel` | Create a floating panel overlay with composited rendering, input routing, and handler-based customization |

## Extension Settings

Extensions read user-configurable settings from `~/.agent-sh/settings.json`, namespaced under the extension name:

```typescript
export default function activate(ctx) {
  const config = ctx.getExtensionSettings("my-extension", {
    maxItems: 10,
    color: "blue",
  });
  // config.maxItems, config.color — typed, merged with user overrides
}
```

Users configure in `~/.agent-sh/settings.json`:
```json
{
  "my-extension": { "maxItems": 50, "color": "red" }
}
```

## Event Bus

The bus has three patterns. The key difference: **`on`/`emit` is fire-and-forget** (listeners can't change anything), while **`onPipe`/`emitPipe` is a transform chain** (each listener modifies the payload for the next).

### `on` / `emit` — Notifications

Broadcast an event. Listeners react but can't affect the payload or the emitter. Use this for logging, UI updates, and side effects.

```typescript
// Emitter doesn't care what listeners do
bus.emit("ui:info", { message: "Operation completed" });

// Listener reacts but can't change the event
bus.on("shell:command-done", ({ command, output, exitCode }) => {
  if (exitCode !== 0) bus.emit("ui:suggestion", { text: "Command failed" });
});
```

### `onPipe` / `emitPipe` — Synchronous Transform Chain

Each listener receives the payload, **returns a modified version**, and that becomes the input for the next listener. The emitter gets back the final result. Use this when you need extensions to intercept or transform data.

```typescript
// Emitter sends a payload through the chain and reads the result
const result = bus.emitPipe("agent:terminal-intercept", {
  command, cwd, intercepted: false, output: "",
});
if (result.intercepted) return result.output;  // an extension handled it

// Listener transforms the payload (or returns it unchanged to pass through)
bus.onPipe("agent:terminal-intercept", (payload) => {
  if (payload.command !== "my-tool") return payload;  // not mine, pass through
  return { ...payload, intercepted: true, output: "custom output" };
});
```

Another common use — multiple extensions enriching a payload:
```typescript
// Each extension appends its own completions
bus.onPipe("autocomplete:request", (payload) => {
  return { ...payload, items: [...payload.items, { name: "/greet", description: "Say hello" }] };
});
```

### `onPipeAsync` / `emitPipeAsync` — Async Transform Chain

Same as `onPipe` but listeners can be async. Also notifies regular `on` listeners first (so UI can prepare before async work starts). Use this for transforms that need I/O — permission prompts, shell execution, network calls.

```typescript
// Permission system: emit a request, wait for extensions to decide
const result = await bus.emitPipeAsync("permission:request", {
  kind: "tool-call", title: toolName, decision: { outcome: "approved" },
});
if (result.decision.outcome !== "approved") { /* denied */ }

// Interactive extension: prompt the user asynchronously
bus.onPipeAsync("permission:request", async (payload) => {
  const answer = await promptUser(`Allow ${payload.title}?`);
  return { ...payload, decision: { outcome: answer } };
});
```

### `emitTransform` — Pipe Then Notify

A convenience combo: runs the payload through the `onPipe` transform chain, then emits the result to regular `on` listeners. This is the standard way to emit content that should be both transformable and renderable.

```typescript
// Without emitTransform (two steps):
const transformed = bus.emitPipe("agent:response-chunk", { blocks });
bus.emit("agent:response-chunk", transformed);

// With emitTransform (same thing, one call):
bus.emitTransform("agent:response-chunk", { blocks });
```

This is how agent backends emit response chunks — extensions get a chance to transform the content (e.g. LaTeX → image) before the renderer sees it.

## Custom Agent Backends

An extension can replace the entire agent backend — the component that receives queries and produces responses. The built-in backend (AgentLoop) uses an OpenAI-compatible API with tool calling, but you can swap it for anything: a local model, a proprietary agent service, a deterministic script, or a test stub.

### How it works

During `activate()`, emit `agent:register-backend` to claim the backend role. This prevents the built-in AgentLoop from activating. From that point, your extension is responsible for handling queries.

Here's a minimal working backend:

```typescript
import type { ExtensionContext } from "../../src/types.js";

export default function activate({ bus }: ExtensionContext): void {
  // 1. Register — claims the backend role before activateBackend() runs
  bus.emit("agent:register-backend", {
    name: "echo",
    kill: () => {},
  });

  // 2. Handle queries — listen for submits, emit the response protocol
  bus.on("agent:submit", ({ query }) => {
    bus.emit("agent:processing-start", {});
    bus.emit("agent:query", { query });

    // Use emitTransform so the content pipeline processes response chunks
    bus.emitTransform("agent:response-chunk", {
      blocks: [{ type: "text", text: `Echo: ${query}\n` }],
    });

    bus.emitTransform("agent:response-done", {
      response: `Echo: ${query}`,
    });

    bus.emit("agent:processing-done", {});
  });

  // 3. Identify yourself (shown in the TUI prompt)
  bus.emit("agent:info", { name: "echo-backend", version: "1.0.0" });
}
```

### Event protocol

A backend listens for input events and emits output events. The TUI and all extensions only see bus events — they don't know or care which backend is active.

**Input events** (listen with `bus.on`):

| Event | Payload | Description |
|---|---|---|
| `agent:submit` | `{ query }` | User submitted a query |
| `agent:cancel-request` | `{ silent? }` | User requested cancellation |
| `agent:reset-session` | `{}` | User issued reset — clear conversation state |

**Output events** (emit in this order for each query):

| Step | Event | Payload | Notes |
|---|---|---|---|
| 1 | `agent:processing-start` | `{}` | Starts spinner in TUI |
| 2 | `agent:query` | `{ query }` | Echoes the query for display |
| 3 | `agent:response-chunk` | `{ blocks: ContentBlock[] }` | Use `emitTransform` so content pipeline runs. Emit 0+ times |
| 4 | `agent:response-done` | `{ response }` | Full response text |
| 5 | `agent:processing-done` | `{}` | Stops spinner, returns control to prompt |

**Optional events** for richer backends:

| Event | Payload | When |
|---|---|---|
| `agent:thinking-chunk` | `{ text }` | Reasoning tokens (e.g. DeepSeek-r1) |
| `agent:tool-batch` | `{ groups: [{ kind, tools: [{ name, displayDetail? }] }] }` | Before tool execution — all tools grouped by kind |
| `agent:tool-started` | `{ title, toolCallId?, kind?, icon?, displayDetail?, locations?, batchIndex?, batchTotal? }` | Tool execution beginning |
| `agent:tool-output-chunk` | `{ chunk }` | Streamed tool output |
| `agent:tool-completed` | `{ toolCallId?, exitCode, kind?, resultDisplay? }` | Tool execution finished |
| `agent:error` | `{ message }` | Error during processing |
| `agent:usage` | `{ prompt_tokens, completion_tokens, total_tokens }` | Token usage stats |

The `agent:tool-batch` event lets the TUI prepare group headers before tools execute. `agent:tool-started` now carries display metadata (`icon`, `displayDetail` from `formatCall()`, batch position). `agent:tool-completed` includes a `resultDisplay` (from `formatResult()`) with an optional `summary` string and structured `body`.

### Switching backends at runtime

Multiple backends can be registered at the same time. Use the `/backend` command to list and switch between them:

```
/backend              # list all registered backends (active one marked)
/backend claude-code  # switch to the claude-code backend
/backend agent-sh     # switch back to the built-in backend
```

Switching deactivates the current backend (`kill()`) and activates the new one (`start()`). The built-in backend is always available as `"agent-sh"`.

### Default backend

By default, the built-in AgentLoop (`"agent-sh"`) activates. To make an extension backend the default, set `defaultBackend` in `~/.agent-sh/settings.json`:

```json
{
  "extensions": ["./my-bridge.ts"],
  "defaultBackend": "claude-code"
}
```

On startup, `activateBackend()` checks this setting and activates the named backend if it was registered. If the named backend isn't found (e.g. the extension failed to load), it falls back to any registered backend, then to the built-in AgentLoop.

### Registration timing

Extensions load *before* `activateBackend()` runs. This is what makes `defaultBackend` work — by the time the core decides which backend to activate, all extensions have already registered theirs.

### Real-world bridges

The echo-backend shows the protocol. The `examples/extensions/` directory has two production bridges that wire real agent SDKs into agent-sh. They follow the same pattern — the difference is just which SDK they translate.

#### Claude Code Bridge (`claude-code-bridge/`)

Runs the [Claude Code Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) in-process. Claude Code handles model selection, tool execution, and permissions — agent-sh provides the shell and TUI.

```bash
cp -r examples/extensions/claude-code-bridge ~/.agent-sh/extensions/
cd ~/.agent-sh/extensions/claude-code-bridge && npm install
# Requires: ANTHROPIC_API_KEY in environment
```

**How it works:**

1. **Registers as backend** via `agent:register-backend`
2. **Creates a `user_shell` MCP tool** using the SDK's `tool()` + `createSdkMcpServer()`, wired to `bus.emitPipeAsync("shell:exec-request", ...)`. This gives Claude Code access to the live PTY.
3. **On each `agent:submit`**, calls the SDK's `query()` with the user's prompt, a system prompt preset, and the MCP server attached
4. **Iterates the SDK's async iterator** — maps `stream_event` (text/thinking deltas) and `assistant` messages (tool use blocks) to agent-sh events (`agent:response-chunk`, `agent:thinking-chunk`, `agent:tool-started`)

#### Pi Bridge (`pi-bridge/`)

Runs [pi's coding agent](https://github.com/nickarrow/pi) in-process. Pi brings its own model registry, provider settings, session management, and tools.

```bash
cp -r examples/extensions/pi-bridge ~/.agent-sh/extensions/
cd ~/.agent-sh/extensions/pi-bridge && npm install
# Requires: pi configured separately (~/.pi/settings.json)
```

**How it works:**

1. **Registers as backend** with an async `start()` — pi needs to boot (load config from `~/.pi/`, create services, initialize tools)
2. **Creates a `user_shell` tool** using pi's `ToolDefinition` interface (TypeBox schema). Includes `promptGuidelines` — pi's way of injecting per-tool instructions into the system prompt.
3. **Subscribes to pi's event stream** (`session.subscribe`) — maps pi events to agent-sh events:
   - `message_update` → `agent:response-chunk` or `agent:thinking-chunk`
   - `tool_execution_start/update/end` → `agent:tool-started`, `agent:tool-output-chunk`, `agent:tool-completed`
   - `agent_end` → `agent:response-done` + `agent:processing-done`
4. **Session management** — `agent:reset-session` creates a new pi session via `runtime.newSession()`

#### Writing your own bridge

Both bridges follow the same 5-step structure:

1. **Register as backend** — emit `agent:register-backend` with `name`, `start()`, `kill()`
2. **Create a `user_shell` tool** in the target SDK's format — wire it to `bus.emitPipeAsync("shell:exec-request", ...)` so the external agent can run commands in the live PTY
3. **Listen for `agent:submit`** — forward the query to the external agent
4. **Map the agent's events** to agent-sh bus events (response chunks, tool starts/completions, thinking, errors)
5. **Handle cancellation and reset** — wire `agent:cancel-request` and `agent:reset-session`

The difference between the two bridges is just SDK shape: Claude Code uses an async iterator you `for await` over; pi uses a subscription callback. The translation layer is the same.

## Named Handlers (Advice System)

The event bus transforms *data flowing through events*. Named handlers are different — they let you wrap *function calls*. Think of `define`/`advise`/`call` as a named function registry where any extension can intercept any function.

**`define`** registers a named function. **`call`** invokes it. **`advise`** wraps it — your wrapper receives `next` (the previous implementation) and decides whether to call it, like middleware.

```typescript
// Built-in: tui-renderer defines the default code block handler
ctx.define("render:code-block", (language, code, width) => {
  syntaxHighlight(language, code, width);
});

// Your extension wraps it
ctx.advise("render:code-block", (next, language, code, width) => {
  if (language === "mermaid") return renderMermaid(code);  // handle it yourself
  return next(language, code, width);                      // otherwise pass through
});

// Somewhere in the system, the handler is invoked
ctx.call("render:code-block", "python", codeString, 80);
```

Multiple advisors chain — each wraps the last. First advisor to not call `next` wins.

### When to use `advise` vs `onPipe`

- **`onPipe`**: you want to transform *data* as it flows through the system (autocomplete items, response chunks, intercepted commands). You get a payload, return a modified payload.
- **`advise`**: you want to replace *behavior* — how a code block renders, how an image displays. You get `next` and decide whether to call the original implementation or substitute your own.

Handlers are reserved for **high-power use cases** where multiple independent extensions need to compose behavior on the same operation. Simple read/write access to internals is exposed as direct methods on `ExtensionContext` instead.

### Built-in handlers

#### Agent loop handlers

These are registered by the built-in agent backend and let extensions shape what the LLM sees and how tools execute.

| Handler | Signature | Description |
|---|---|---|
| `dynamic-context:build` | `() → string` | Build per-query context injected before the conversation. Default: tools, conventions, shell history, cwd. |
| `conversation:prepare` | `(messages[]) → messages[]` | Transform the full message array before it's sent to the LLM. Default: pass through. |
| `tool:execute` | `(ctx) → ToolResult` | Wrap the full tool lifecycle: permission → execute → emit events. |

**`dynamic-context:build`** — Each advisor appends its own context. Multiple extensions compose independently:

```typescript
// Add git context to every query
ctx.advise("dynamic-context:build", (next) => {
  const base = next();
  const branch = execSync("git branch --show-current").toString().trim();
  return base + `\nGit branch: ${branch}`;
});
```

**`conversation:prepare`** — Full control over the message array the LLM receives. The default passes messages through unchanged. Extensions can implement compaction, summarization, filtering, sliding window, or any other strategy:

```typescript
// Keep only the last 20 messages to save tokens
ctx.advise("conversation:prepare", (next, messages) => {
  const prepared = next(messages);
  if (prepared.length > 23) { // 3 prefix messages + 20 conversation
    return [...prepared.slice(0, 3), ...prepared.slice(-20)];
  }
  return prepared;
});
```

**`tool:execute`** — Wraps every tool call. The `ctx` argument contains `{ name, id, args, tool, onChunk }`. Extensions can block tools, add logging, implement custom permission policies, retry on failure, run tools in a sandbox, or intercept/transform streamed output:

```typescript
// Safe mode — block all file-modifying tools
ctx.advise("tool:execute", async (next, ctx) => {
  if (ctx.tool.modifiesFiles) {
    return { content: "Blocked: read-only mode", exitCode: 1, isError: true };
  }
  return next(ctx);
});

// Audit log — record every tool execution
ctx.advise("tool:execute", async (next, ctx) => {
  const start = Date.now();
  const result = await next(ctx);
  log(`${ctx.name}: ${Date.now() - start}ms, exit=${result.exitCode}`);
  return result;
});

// Custom permission policy — auto-approve reads, deny /etc access
ctx.advise("tool:execute", async (next, ctx) => {
  const kind = ctx.tool.getDisplayInfo?.(ctx.args)?.kind;
  if (kind === "read") return next(ctx);  // skip permission prompt
  if (ctx.name === "bash" && String(ctx.args.command).includes("/etc")) {
    return { content: "Blocked: /etc access", exitCode: 1, isError: true };
  }
  return next(ctx);
});

// Secret redaction — wrap onChunk to scrub streaming output + final result
ctx.advise("tool:execute", async (next, ctx) => {
  const origOnChunk = ctx.onChunk;
  if (origOnChunk) {
    ctx.onChunk = (chunk) => origOnChunk(redact(chunk));
  }
  const result = await next(ctx);
  return { ...result, content: redact(result.content) };
});
```

The `onChunk` callback controls what the user sees during tool execution (streamed to terminal). Wrapping it lets extensions transform output in real time — for example, redacting secrets before they hit the screen. See `examples/extensions/secret-guard.ts` for a complete implementation.

#### Rendering handlers

These are registered by the tui-renderer and let extensions customize how content is displayed.

| Handler | Signature | Description |
|---|---|---|
| `render:code-block` | `(language: string, code: string, width: number) → void` | Render a fenced code block (default: syntax highlighting) |
| `render:image` | `(data: Buffer) → void` | Display an image in the terminal (default: iTerm2/Kitty protocol) |
| `render:result-body` | `(body: ToolResultBody, width: number) → string[]` | Render structured tool result body (default: diffs or line lists) |

The `render:result-body` handler is called when a tool's `formatResult()` returns a structured `body`. Extensions can advise it to customize how specific result types are displayed:

```typescript
ctx.advise("render:result-body", (next, body, width) => {
  if (body.kind === "diff") return myCustomDiffRenderer(body.diff, body.filePath, width);
  return next(body, width);
});
```

#### Custom handlers

Extensions can define their own handlers for other extensions to advise:

```typescript
ctx.define("my-ext:process-data", (data) => defaultProcessing(data));
// Other extensions can then advise("my-ext:process-data", ...)
```

## Content Transform Pipeline

The agent streams raw text. Before the renderer sees it, the text flows through a transform pipeline that breaks it into typed **content blocks**:

```typescript
type ContentBlock =
  | { type: "text"; text: string }                          // markdown text
  | { type: "code-block"; language: string; code: string }  // fenced code block
  | { type: "image"; data: Buffer }                         // PNG → terminal image protocol
  | { type: "raw"; escape: string }                         // raw terminal escape
```

The pipeline has two layers. **Parsers** turn raw text into blocks (e.g. detecting ` ``` ` fences and emitting `code-block`). **Post-transforms** operate on those blocks (e.g. taking a `code-block` with language "mermaid" and converting it to an `image`). `createBlockTransform` and `createFencedBlockTransform` are parsers; `bus.onPipe("agent:response-chunk")` is the post-transform layer.

| I want to... | Use | Layer |
|---|---|---|
| Match inline delimiters (`$$`, `<<`, etc.) | `ctx.createBlockTransform` | Parser — text in, blocks out |
| Match fenced blocks (` ``` `, `:::`, `~~~`) | `ctx.createFencedBlockTransform` | Parser — text in, blocks out |
| Transform blocks others produced | `bus.onPipe("agent:response-chunk", ...)` | Post-transform — blocks in, blocks out |

Parsers only read `text` blocks and pass other block types through. Post-transforms see all block types. This means they compose regardless of registration order — each operates on a disjoint domain.

### Inline delimiter transforms

Parsers that detect patterns like `$$...$$` within text. They handle streaming buffering and flush-on-done automatically — you just provide the delimiters and a transform function:

```typescript
ctx.createBlockTransform({
  open: "$$",
  close: "$$",
  transform(content) {
    // content = text between delimiters (e.g. "E = mc^2")
    // Return ContentBlock(s) or null to keep original
    const png = renderToPng(content);
    return png ? { type: "image", data: png } : null;
  },
});
```

### Fenced block transforms

Parsers that detect line-delimited fenced blocks. Open/close patterns are regexes:

```typescript
// :::warning ... ::: admonition blocks
ctx.createFencedBlockTransform({
  open: /^:::(\w+)\s*$/,
  close: /^:::\s*$/,
  transform(match, content) {
    const kind = match[1]; // "warning", "note", etc.
    return { type: "text", text: `⚠️ ${kind.toUpperCase()}: ${content}` };
  },
});
```

The tui-renderer uses this same primitive for standard ` ``` ` code fences — it's not special.

### Post-transforms: claiming blocks from other transforms

Use `bus.onPipe` to transform blocks that a parser already produced. This is how you claim specific code block languages, convert block types, or filter output:

```typescript
// A parser already turned ```mermaid ... ``` into a code-block.
// This post-transform claims it and converts to an image.
bus.onPipe("agent:response-chunk", (e) => ({
  blocks: e.blocks.map(block => {
    if (block.type !== "code-block" || block.language !== "mermaid") return block;
    const png = renderMermaid(block.code);
    return png ? { type: "image", data: png } : block;
  }),
}));
```

### Example: LaTeX image rendering

`examples/extensions/latex-images.ts` renders both `$$...$$` and ` ```latex ` blocks as terminal images — using a parser for the inline math and a post-transform for the code fences:

```bash
# Requires: latex + dvipng (brew install --cask mactex)
# Requires: iTerm2, WezTerm, Kitty, or Ghostty
agent-sh -e ./examples/extensions/latex-images.ts
```

## Custom Input Modes

Input modes change what happens when the user types and presses Enter. Each mode binds a trigger character (typed at the start of an empty line) to a custom `onSubmit` handler. The built-in mode (`>` for agent) is registered this way — it's not special.

The flow: user types trigger → prompt changes to show the mode → user types their input → presses Enter → `onSubmit` fires → your handler emits `agent:submit`. You can optionally include a `modeInstruction` that gets prepended to the user message.

```typescript
bus.emit("input-mode:register", {
  id: "translate",           // unique identifier
  trigger: "!",              // single char — typed at empty line start
  label: "translate",        // shown in prompt
  promptIcon: "⟩",           // chevron/icon character
  indicator: "🌐",           // status indicator before the icon
  onSubmit(query, bus) {
    bus.emit("agent:submit", {
      query,                 // what the user typed
      modeInstruction: "[mode: translate] Translate the following to Spanish.",
    });
  },
  returnToSelf: true,        // re-enter this mode after agent finishes
});
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier |
| `trigger` | `string` | Single character that activates the mode at empty line start |
| `label` | `string` | Shown in the prompt area |
| `promptIcon` | `string` | Chevron/icon character in the prompt |
| `indicator` | `string` | Status indicator before the icon |
| `onSubmit` | `(query, bus) => void` | Called on Enter. Emits `agent:submit` with `query` + optional `modeInstruction` |
| `returnToSelf` | `boolean` | Re-enter this mode after the agent finishes |

Each trigger character can only be claimed by one mode. Slash commands and readline keybindings work in every mode.

## Terminal Buffer & Floating Panel

agent-sh exposes two core utilities for building interactive terminal overlays.

### TerminalBuffer

A headless xterm.js terminal that mirrors the real terminal's output. Accessed via `ctx.terminalBuffer` (lazy singleton, shared across extensions). Returns `null` if `@xterm/headless` is not installed.

```typescript
const tb = ctx.terminalBuffer;
if (tb) {
  const { text, altScreen, cursorX, cursorY } = tb.readScreen();
  console.log(altScreen ? "vim/htop is running" : "normal shell");
}
```

Key methods:
- `readScreen()` — clean text snapshot with cursor position and alt screen detection
- `getScreenLines(rows?)` — array of viewport lines (for compositing)
- `serialize()` — raw serialized output including ANSI sequences
- `altScreen` — whether the alternate screen buffer is active
- `write(data)` / `resize(cols, rows)` — manual control

The buffer reads from the active viewport (not scrollback), so it works correctly on both the normal and alternate screen buffers.

Install the optional xterm dependency:
```bash
npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
```

### FloatingPanel

A composited overlay rendered over the terminal. Handles the full lifecycle: alt screen management, input routing, dimmed background compositing, scroll, and screen restore.

```typescript
const panel = ctx.createFloatingPanel({
  trigger: "\x1c",       // Ctrl+\ to toggle
  dimBackground: true,   // show dimmed terminal behind the panel
  autoDismissMs: 2000,   // auto-close 2s after setDone()
  borderStyle: "rounded",
  width: "80%",
  height: "60%",
});

panel.handlers.advise("panel:submit", (_next, query: string) => {
  panel.setActive();
  panel.appendLine(`> ${query}`);
  // process the query...
});
```

**Config options**: `trigger`, `width`, `height`, `maxWidth`, `minHeight`, `borderStyle` (`rounded`/`square`/`double`/`heavy`), `dimBackground`, `autoDismissMs`, `promptIcon`, `handlerPrefix`.

**Lifecycle** — the panel has four phases and three rendering states:

```
open() → [input] → submit → [active] → setDone() → [input] (follow-up)
                                │                         │
                              hide()                    hide()
                                │                         │
                          [passthrough]                dismiss()
                       (agent still working,        (session over,
                        TerminalBuffer renders       teardown + SIGWINCH)
                        screen at 50ms interval)
                                │
                          setDone() while
                          passthrough
                                │
                           auto-dismiss()
                        (hand back control)
```

| Phase | Description |
|-------|-------------|
| **input** | Waiting for user query (or follow-up after agent finishes) |
| **active** | Agent is processing — hide enters passthrough mode |
| **done** | Legacy: used with `autoDismissMs > 0` only |
| **idle** | Panel fully dismissed, no state retained |

**Passthrough mode**: When the user hides the panel while the agent is still working (`active` phase), the panel enters passthrough mode instead of handing rendering back to the foreground program. It stays on alt screen with stdout held, and renders the TerminalBuffer content directly at 50ms intervals. This avoids ncurses curscr desync — the program's screen stays correct because we do full repaints, not differential updates. When the agent finishes (`setDone()`), passthrough auto-dismisses and hands back control via a SIGWINCH double-resize that forces ncurses to do a clean full repaint.

**Content API**: `appendText(text)`, `appendLine(line)`, `updateLastLine(fn)`, `clearContent()`, `setTitle(title)`, `setFooter(footer)`.

**Handler-based rendering** — all rendering is customizable via the handler/advise pattern:

| Handler | Purpose |
|---|---|
| `render-frame(ctx: FrameContext) → FrameResult` | Replace the entire frame rendering |
| `render-border-top(ctx: FrameContext) → string` | Custom title bar |
| `render-border-bottom(ctx: FrameContext) → string` | Custom footer bar |
| `composite-row(boxLine, bgLine, ...) → string` | Custom background compositing |
| `render-content(ctx: RenderContext) → RenderResult` | Content inside the box |
| `build-row(content, width) → string` | Row truncation/padding |
| `submit(query) → void` | Handle submitted input |
| `dismiss() → void` | Handle panel dismissal |
| `input(data) → boolean` | Custom input handling |

**Alt screen nesting**: FloatingPanel detects when a foreground program (vim, htop) is already on alt screen and avoids entering a second alt screen (which doesn't nest in most terminals). Instead, it renders directly on top of the program's alt screen.

**Screen restore**: On dismiss, the panel uses a SIGWINCH double-resize (resize to `rows-1`, then back to `rows`) to force the foreground program to fully repaint. This is necessary because ncurses ignores same-size SIGWINCH (`resizeterm` returns early when dimensions haven't changed), and ncurses's `curscr` is stale after the overlay drew on the terminal — a simple exit from alt screen would leave overlay artifacts in cells that ncurses considers unchanged.

**Keyboard protocol support**: The trigger key is recognized in all encodings — raw control byte, xterm modifyOtherKeys (`\e[27;5;code~`), and kitty keyboard protocol (`\e[code;5u`). This ensures the trigger works inside vim and other programs that enable extended keyboard protocols.

## Rendering Architecture

The tui-renderer turns content blocks into terminal output. All output flows through an **OutputWriter** (`write(text)` + `columns`). Extensions should never call `process.stdout.write` directly.

```
ContentBlock (from transform pipeline)
    ├── text        → MarkdownRenderer.push(chunk) → drainLines() → writer
    ├── code-block  → ctx.call("render:code-block") → drainLines() → writer
    ├── image       → ctx.call("render:image")       → writer
    └── raw         → writer.write(escape)
```

Rendering components follow a **return lines, don't write** convention — each returns `string[]`, making them testable in isolation:

- `renderBoxFrame(content, opts)` → `string[]`
- `renderDiff(diff, opts)` → `string[]`
- `renderToolCall(tool, width)` → `string[]`
- `renderSpinnerLine(state, label, opts)` → `string`
- `MarkdownRenderer.drainLines()` → `string[]`

## Yolo Mode

By default, agent-sh runs in **yolo mode** — all tool calls and file writes are auto-approved. To add permission prompts, load the example extension:

```bash
npm start -- -e ./examples/extensions/interactive-prompts.ts

# Or install permanently:
cp examples/extensions/interactive-prompts.ts ~/.agent-sh/extensions/
```

## Theming

agent-sh uses a semantic color palette (~10 base roles). Override any slot via `setPalette()`:

```typescript
export default function activate({ setPalette }) {
  setPalette({
    accent:  "\x1b[38;2;38;139;210m",   // solarized blue
    success: "\x1b[38;2;133;153;0m",     // solarized green
    warning: "\x1b[38;2;181;137;0m",     // solarized yellow
    error:   "\x1b[38;2;220;50;47m",     // solarized red
    muted:   "\x1b[38;2;88;110;117m",    // solarized base01
  });
}
```

Load a theme like any other extension: `npm start -- -e ./my-theme.ts`
