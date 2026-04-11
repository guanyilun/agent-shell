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
| `define` | `(name, fn) => void` | Register a named handler |
| `advise` | `(name, wrapper) => void` | Wrap a named handler (receives `next` + args) |
| `call` | `(name, ...args) => any` | Call a named handler |

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

Here's a complete working backend (`examples/extensions/echo-backend.ts`):

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

```bash
agent-sh -e examples/extensions/echo-backend.ts
```

### Event protocol

A backend listens for input events and emits output events. The TUI and all extensions only see bus events — they don't know or care which backend is active.

**Input events** (listen with `bus.on`):

| Event | Payload | Description |
|---|---|---|
| `agent:submit` | `{ query, modeInstruction?, modeLabel? }` | User submitted a query |
| `agent:cancel-request` | `{ silent? }` | User requested cancellation |
| `agent:reset-session` | `{}` | User issued reset — clear conversation state |

**Output events** (emit in this order for each query):

| Step | Event | Payload | Notes |
|---|---|---|---|
| 1 | `agent:processing-start` | `{}` | Starts spinner in TUI |
| 2 | `agent:query` | `{ query, modeLabel? }` | Echoes the query for display |
| 3 | `agent:response-chunk` | `{ blocks: ContentBlock[] }` | Use `emitTransform` so content pipeline runs. Emit 0+ times |
| 4 | `agent:response-done` | `{ response }` | Full response text |
| 5 | `agent:processing-done` | `{}` | Stops spinner, returns control to prompt |

**Optional events** for richer backends:

| Event | Payload | When |
|---|---|---|
| `agent:thinking-chunk` | `{ text }` | Reasoning tokens (e.g. DeepSeek-r1) |
| `agent:tool-started` | `{ title, toolCallId?, kind? }` | Tool execution beginning |
| `agent:tool-output-chunk` | `{ chunk }` | Streamed tool output |
| `agent:tool-completed` | `{ toolCallId?, exitCode }` | Tool execution finished |
| `agent:error` | `{ message }` | Error during processing |
| `agent:usage` | `{ prompt_tokens, completion_tokens, total_tokens }` | Token usage stats |

### Registration timing

Extensions load *before* `activateBackend()` runs. When `activateBackend()` sees that an extension registered a backend, it calls the extension's `start?.()` (if provided) and skips the built-in AgentLoop entirely. This means your extension has full control — the default backend never wires up.

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

### Built-in handlers

The tui-renderer registers these handlers that extensions can advise:

| Handler | Arguments | Description |
|---|---|---|
| `render:code-block` | `(language: string, code: string, width: number)` | Render a fenced code block (default: syntax highlighting) |
| `render:image` | `(data: Buffer)` | Display an image in the terminal (default: iTerm2/Kitty protocol) |

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

Input modes change what happens when the user types and presses Enter. Each mode binds a trigger character (typed at the start of an empty line) to a custom `onSubmit` handler. The built-in modes (`?` for query, `>` for execute) are registered this way — they're not special.

The flow: user types trigger → prompt changes to show the mode → user types their input → presses Enter → `onSubmit` fires → your handler emits `agent:submit` with a `modeInstruction` that gets prepended to the agent's system prompt, telling it how to behave in this mode.

```typescript
bus.emit("input-mode:register", {
  id: "translate",           // unique identifier
  trigger: "!",              // single char — typed at empty line start
  label: "translate",        // shown in prompt
  promptIcon: "⟩",           // chevron/icon character
  indicator: "🌐",           // status indicator before the icon
  onSubmit(query, bus) {
    // This is where you control what the agent sees.
    // modeInstruction is prepended to the prompt — it's how you steer the agent.
    bus.emit("agent:submit", {
      query,                 // what the user typed
      modeLabel: "Translate",
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
| `onSubmit` | `(query, bus) => void` | Called on Enter. Emits `agent:submit` with `query` + `modeInstruction` |
| `returnToSelf` | `boolean` | Re-enter this mode after the agent finishes |

Each trigger character can only be claimed by one mode. Slash commands and readline keybindings work in every mode.

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
