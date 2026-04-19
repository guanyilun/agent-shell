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
| `contextManager` | `ContextManager` | Shell exchange history — `getCwd()`, `search(query)`, `getRecentSummary(n)`, `getEventsSince(afterId)`, `lastSeq()` |
| `instanceId` | `string` | Stable per-instance identifier (4-char hex) |
| `quit` | `() => void` | Exit agent-sh |
| `setPalette` | `(overrides) => void` | Override color palette slots for theming |
| `createBlockTransform` | `(opts) => void` | Register an inline delimiter transform (e.g. `$$...$$`) |
| `createFencedBlockTransform` | `(opts) => void` | Register a fenced block transform (e.g. ` ```lang...``` `) |
| `getExtensionSettings` | `(namespace, defaults) => T` | Read extension settings from `~/.agent-sh/settings.json` |
| `getStoragePath` | `(namespace) => string` | Get (and lazily create) a per-extension storage directory under `~/.agent-sh/<namespace>/` |
| `registerTool` | `(tool: ToolDefinition) => void` | Register a tool with the active agent backend. See [Internal Agent: Tool interface](agent.md#tool-interface) |
| `unregisterTool` | `(name: string) => void` | Remove a previously registered tool |
| `getTools` | `() => ToolDefinition[]` | Get all registered tools |
| `registerCommand` | `(name, description, handler) => void` | Register a slash command (e.g. `/mycommand`) |
| `registerInstruction` | `(name, text) => void` | Inject a named instruction block into the system prompt |
| `removeInstruction` | `(name) => void` | Remove a named instruction block |
| `registerSkill` | `(name, description, filePath) => void` | Register a skill — on-demand reference material the agent can invoke |
| `removeSkill` | `(name) => void` | Remove a registered skill |
| `define` | `(name, fn) => void` | Register a named handler |
| `advise` | `(name, wrapper) => () => void` | Wrap a named handler (receives `next` + args). Returns an `unadvise()` function. |
| `call` | `(name, ...args) => any` | Call a named handler |
| `list` | `() => string[]` | Names of all registered handlers (for diagnostic/introspection use) |
| `terminalBuffer` | `TerminalBuffer \| null` | Shared headless xterm.js buffer mirroring PTY output (lazy singleton, null if `@xterm/headless` not installed) |
| `compositor` | `Compositor` | Routes named render streams to surfaces. See [TUI Composition](tui-composition.md) |
| `createRemoteSession` | `(opts: RemoteSessionOptions) => RemoteSession` | Create a remote session that routes agent output to a surface. See [Remote Sessions](#remote-sessions) |

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
// Emitter sends a payload through the chain and reads the result.
// `agent:terminal-intercept` is emitted by the `bash` tool before
// execution — extensions can short-circuit specific commands with
// virtual output and skip the subprocess. No built-in extension uses
// this today; it's a general hook for custom virtual commands.
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

An extension can provide an agent backend — the component that receives queries and produces responses. The built-in backend (`agent-backend` extension, which creates AgentLoop) uses an OpenAI-compatible API with tool calling. You can add alternatives: a local model, a proprietary agent service, a deterministic script, or a test stub. All backends — including the built-in one — register via the same `agent:register-backend` mechanism.

### How it works

During `activate()`, emit `agent:register-backend` to register your backend. Multiple backends can coexist; the user switches between them with `/backend`. Set `defaultBackend` in settings to control which activates on startup.

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
/backend ash          # switch back to the built-in backend
```

Switching deactivates the current backend (`kill()`) and activates the new one (`start()`).

### Default backend

By default, the built-in `"ash"` backend activates (registered by the `agent-backend` built-in extension). To make an extension backend the default, set `defaultBackend` in `~/.agent-sh/settings.json`:

```json
{
  "extensions": ["./my-bridge.ts"],
  "defaultBackend": "claude-code"
}
```

On startup, `activateBackend()` checks this setting and activates the named backend if it was registered. If the named backend isn't found, it falls back to the first registered backend.

To disable the built-in agent entirely (e.g., for bridge-only setups):
```json
{
  "disabledBuiltins": ["agent-backend"],
  "defaultBackend": "claude-code"
}
```

### Registration timing

Built-in extensions load first (via a declarative manifest), then user extensions, then `activateBackend()` runs. This is what makes `defaultBackend` work — by the time the core decides which backend to activate, all extensions have registered theirs.

### Real-world bridges

The echo-backend shows the protocol. The `examples/extensions/` directory has two production bridges that wire real agent SDKs into agent-sh. Both are **pure protocol translators** — they map the external SDK's event stream to agent-sh's bus events, and that's it. Neither bundles any tools of its own; each external agent uses its own built-in tools as-is.

PTY-access tools (`terminal_read`, `terminal_keys`, `user_shell`) are deliberately *not* part of a bridge's job. They're opt-in capabilities that live in their own extensions, registered per backend in that backend's tool format. Keeping this separation means bridges stay narrow and composable.

#### Claude Code Bridge (`claude-code-bridge/`)

Runs the [Claude Code Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) in-process. Claude Code handles model selection, tool execution, and permissions — agent-sh provides the shell and TUI.

```bash
cp -r examples/extensions/claude-code-bridge ~/.agent-sh/extensions/
cd ~/.agent-sh/extensions/claude-code-bridge && npm install
# Requires: ANTHROPIC_API_KEY in environment
```

**How it works:**

1. **Registers as backend** via `agent:register-backend`
2. **On each `agent:submit`**, calls the SDK's `query()` with the user's prompt and a system-prompt preset. Claude Code's own tools (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`) handle everything.
3. **Iterates the SDK's async iterator** — maps `stream_event` (text/thinking deltas) and `assistant` messages (tool use blocks) to agent-sh events (`agent:response-chunk`, `agent:thinking-chunk`, `agent:tool-started`)
4. **Snapshots files before Edit/Write** so it can compute a diff when the tool result comes back, for the TUI's inline diff rendering

#### Pi Bridge (`pi-bridge/`)

Runs [pi's coding agent](https://github.com/nickarrow/pi) in-process. Pi brings its own model registry, provider settings, session management, and tools.

```bash
cp -r examples/extensions/pi-bridge ~/.agent-sh/extensions/
cd ~/.agent-sh/extensions/pi-bridge && npm install
# Requires: pi configured separately (~/.pi/settings.json)
```

**How it works:**

1. **Registers as backend** with an async `start()` — pi needs to boot (load config from `~/.pi/`, create services, initialize tools)
2. **Subscribes to pi's event stream** (`session.subscribe`) — maps pi events to agent-sh events:
   - `message_update` → `agent:response-chunk` or `agent:thinking-chunk`
   - `tool_execution_start/update/end` → `agent:tool-started`, `agent:tool-output-chunk`, `agent:tool-completed`
   - `agent_end` → `agent:response-done` + `agent:processing-done`
3. **Session management** — `agent:reset-session` creates a new pi session via `runtime.newSession()`

#### Adding PTY access to a bridge

Neither bridge bundles PTY tools. If you want the external agent to observe or mutate the user's live terminal, write a companion extension that registers tools in the target SDK's tool format:

- **`terminal_read`** — reads `ctx.terminalBuffer.readScreen()` and returns the text + cursor + alt-screen state
- **`terminal_keys`** — emits `shell:pty-write` to send keystrokes to the PTY
- **`user_shell`** — emits `shell:exec-request` and awaits the result, for `cd`/`export`/`source`-level state mutation

For pi, this is a standalone extension that registers with pi's `customTools` (via `ctx.call` or a pi-specific hook). For Claude Code, the SDK accepts MCP servers in `query()` options — so the companion extension builds the MCP server and either forks the bridge or coordinates with it via a handler to attach the server.

#### Writing your own bridge

Both bridges follow the same 4-step structure:

1. **Register as backend** — emit `agent:register-backend` with `name`, `start()`, `kill()`
2. **Listen for `agent:submit`** — forward the query to the external agent
3. **Map the agent's events** to agent-sh bus events (response chunks, tool starts/completions, thinking, errors)
4. **Handle cancellation and reset** — wire `agent:cancel-request` and `agent:reset-session`

The difference between the two bridges is just SDK shape: Claude Code uses an async iterator you `for await` over; pi uses a subscription callback. The translation layer is the same. Keep PTY tools out — they belong in companion extensions.

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

These are registered by the `agent-backend` built-in extension (AgentLoop) and let other extensions shape what the LLM sees and how tools execute. They are only available when the built-in agent is active.

| Handler | Signature | Description |
|---|---|---|
| `system-prompt:build` | `() → string` | Assemble the cached system prompt. Advise to append identity blocks, memory files, learned lessons, etc. Rebuilt on cwd change, not every query. |
| `dynamic-context:build` | `() → string` | Build the per-iteration user-role injection. Rebuilt before every LLM call. Default: `<shell>` + `<environment>` XML-tagged sections. Advisors add more tagged sections. |
| `conversation:prepare` | `(messages[]) → messages[]` | Transform the full message array before it's sent to the LLM. Default: pass through. |
| `conversation:compact` | `({target, keepRecent, force}) → { before, after, evictedCount }` | Compaction strategy. Default: pins the first turn + the last `keepRecent` turns and evicts the middle by priority × recency. Advise for richer strategies (topic pinning, LLM summarization). |
| `conversation:get-messages` | `() → messages[]` | Read the current in-memory messages array. Used by compaction advisors to compute a replacement. |
| `conversation:replace-messages` | `(messages[]) → void` | Install a replacement messages array. The corresponding mutate-side of the compaction pattern. |
| `conversation:estimate-tokens` | `() → number` | Local chars/4 estimate of the conversation size. |
| `conversation:estimate-prompt-tokens` | `() → number` | API-grounded estimate (last `prompt_tokens` + local delta since). Used by the auto-compact trigger. |
| `conversation:inject-note` | `(text) → void` | Inject a `role:"user"` note mid-loop — how extensions deliver async results (subagent output, peer messages) into the next iteration. |
| `conversation:nucleate-user` / `-agent` / `-tool` | `(msg) → NuclearEntry` | Turn a message into its one-line summary. Advise to extract extra metadata (e.g. `[why: ...]` annotations). |
| `conversation:format-prior-history` | `(entries) → string` | Render prior-session history into a preamble. Advise for session-grouped output. |
| `history:append` / `:search` / `:find-by-seq` / `:read-recent` | — | Shell-history-style persistent log at `~/.agent-sh/history`. Advise to add indexing, filtering, or external stores. |
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

**`tool:execute`** — Wraps every tool call. The `ctx` argument contains `{ name, id, args, tool, onChunk }`. Use cases: blocking tools, logging, custom permission policies, output redaction.

```typescript
// Safe mode — block all file-modifying tools
ctx.advise("tool:execute", async (next, ctx) => {
  if (ctx.tool.modifiesFiles) {
    return { content: "Blocked: read-only mode", exitCode: 1, isError: true };
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

The `onChunk` callback controls what the user sees during tool execution (streamed to terminal). See `examples/extensions/secret-guard.ts` for a complete implementation.

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

## Terminal Buffer

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

Install the optional xterm dependency:
```bash
npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
```

## FloatingPanel

> **Note**: FloatingPanel is an internal utility in `src/utils/floating-panel.ts`, not part of the public ExtensionContext API. It's used by the [overlay-agent](../examples/extensions/overlay-agent.ts) example extension. Import it directly if you need it.

A composited overlay rendered over the terminal. Handles alt screen management, input routing, dimmed background compositing, scroll, and screen restore.

```typescript
import { FloatingPanel } from "agent-sh/utils/floating-panel";

const panel = new FloatingPanel(bus, {
  trigger: "\x1c",       // Ctrl+\ to toggle
  dimBackground: true,
  terminalBuffer: ctx.terminalBuffer ?? undefined,
});
```

**Config options**: `trigger`, `width`, `height`, `maxWidth`, `minHeight`, `borderStyle` (`rounded`/`square`/`double`/`heavy`), `dimBackground`, `autoDismissMs`, `promptIcon`, `handlerPrefix`.

**Content API**: `appendText(text)`, `appendLine(line)`, `updateLastLine(fn)`, `clearContent()`, `setTitle(title)`, `setFooter(footer)`.

**Lifecycle**: `open()` → input → `submit` → `setActive()` → agent processes → `setDone()` → input (follow-up) or `dismiss()`. When hidden during active processing, the panel enters passthrough mode (renders TerminalBuffer content directly) until the agent finishes.

See `src/utils/floating-panel.ts` for the full API, handler hooks, and rendering customization.

## Remote Sessions

A remote session bundles all the wiring needed to route agent output away from stdout — compositor redirects, shell lifecycle advisors, and chrome suppression — into a single call. Use it when building side panes, web UIs, remote displays, or any extension where agent output should appear somewhere other than the main terminal.

```typescript
const session = ctx.createRemoteSession({
  surface: mySurface,          // where output goes (RenderSurface)
  suppressQueryBox: true,      // hide query box (session has own input)
  interactive: true,           // set interactive-session context
});

session.submit("what's on screen?");  // submit a query
session.close();                       // restore everything
```

### RemoteSessionOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `surface` | `RenderSurface` | (required) | The surface to render agent output to |
| `suppressBorders` | `boolean` | `true` | Suppress response top/bottom borders |
| `suppressQueryBox` | `boolean` | `false` | Suppress the user query box (use when the session has its own input) |
| `suppressUsage` | `boolean` | `true` | Suppress token usage stats line |
| `interactive` | `boolean` | `false` | Add `interactive-session: true` to dynamic context. Signals to the agent that it is operating inside an interactive surface (e.g. an overlay or side pane) rather than the main shell. Extensions that provide PTY-inspection tools (like the `terminal-buffer` example) watch this flag. |

### What createRemoteSession handles

Internally, a remote session:

1. **Redirects render streams** — `"agent"`, `"query"`, `"status"` all route to the provided surface
2. **Keeps the shell interactive** — advises `shell:on-processing-start` and `shell:on-processing-done` to skip pause/unpause
3. **Suppresses chrome** — advises `tui:response-border`, `tui:render-user-query`, `tui:render-usage` based on options
4. **Sets dynamic context** — advises `dynamic-context:build` to inject `interactive-session: true` when `interactive` is set

Calling `session.close()` removes all advisors and restores all compositor routing in one call.

### Example: tmux side pane

```typescript
// Output-only: queries from main shell, output in side pane
const session = ctx.createRemoteSession({ surface });
// session.close() when done

// Interactive: side pane has own input prompt
const session = ctx.createRemoteSession({
  surface,
  suppressQueryBox: true,
  interactive: true,
});
conn.on("data", (d) => session.submit(d.toString().trim()));
```

### Example: overlay agent

```typescript
const session = ctx.createRemoteSession({
  surface: panelSurface,
  suppressQueryBox: true,
  interactive: true,
});
session.submit(query);
// ... later, on dismiss ...
session.close();
```

## Shell Lifecycle Handlers

The shell's behavior during agent processing is controlled by two advisable handlers. Extensions advise these to change how the shell responds when the agent starts and stops working.

### `shell:on-processing-start`

Default: pauses the shell (blocks PTY output and input) while the agent works. This is correct when agent output shares stdout with the terminal.

```typescript
// Skip pause — agent output goes to a separate surface
ctx.advise("shell:on-processing-start", (next) => {
  if (mySessionActive) return;  // don't pause
  return next();                // default: pause
});
```

### `shell:on-processing-done`

Default: unpauses the shell, re-enters agent input mode or redraws the shell prompt.

```typescript
// Skip prompt redraw — already handled by the extension
ctx.advise("shell:on-processing-done", (next) => {
  if (mySessionActive) return;  // skip
  return next();                // default: unpause + redraw
});
```

> **Note:** `createRemoteSession()` advises both of these automatically. You only need to advise them directly if you're building custom lifecycle behavior without using remote sessions.

## Rendering Architecture

The tui-renderer turns content blocks into terminal output. All output flows through the **compositor**, which routes named streams (`"agent"`, `"query"`, `"status"`) to **render surfaces**. Extensions should never call `process.stdout.write` directly.

```
ContentBlock (from transform pipeline)
    ├── text        → MarkdownRenderer.push(chunk) → drainLines() → compositor
    ├── code-block  → ctx.call("render:code-block") → drainLines() → compositor
    ├── image       → ctx.call("render:image")       → compositor
    └── raw         → compositor.surface("agent").write(escape)
```

Extensions can redirect any stream to a different surface (e.g. a floating panel):

```typescript
// Redirect agent output to a panel
const restore = ctx.compositor.redirect("agent", panelSurface);
// ... later ...
restore(); // back to stdout
```

Streams are hierarchical: `"agent:diff"` falls back to `"agent"` if no override exists. See [TUI Composition](tui-composition.md) for the full compositor design, surface API, and examples.

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
