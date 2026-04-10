# Extensions

## Writing Extensions

An extension is a module that exports a default (or named `activate`) function. It receives an `ExtensionContext` with access to all core services:

```typescript
// my-extension.ts
export default function activate(ctx) {
  const { bus } = ctx;

  // Listen to agent events
  bus.on("agent:response-done", (e) => {
    console.log(`Agent responded with ${e.response.length} chars`);
  });

  // Add a slash command
  bus.on("command:execute", (e) => {
    if (e.name === "/greet") {
      bus.emit("ui:info", { message: "Hello from my extension!" });
    }
  });
  bus.onPipe("autocomplete:request", (payload) => {
    if (!payload.buffer.startsWith("/g")) return payload;
    return { ...payload, items: [...payload.items, { name: "/greet", description: "Say hello" }] };
  });

  // Intercept terminal commands
  bus.onPipe("agent:terminal-intercept", (payload) => {
    if (payload.command !== "my-tool") return payload;
    return { ...payload, intercepted: true, output: "custom output" };
  });

  // Register an MCP server for the agent to discover
  bus.onPipe("session:configure", (payload) => {
    return {
      ...payload,
      mcpServers: [...payload.mcpServers, {
        name: "my-tool",
        command: "node",
        args: ["/path/to/my-mcp-server.js"],
        env: [{ name: "MY_VAR", value: "value" }],
      }],
    };
  });
}
```

### ExtensionContext API

| Property | Type | Description |
|---|---|---|
| `bus` | `EventBus` | Subscribe to events, emit events, register pipe handlers |
| `contextManager` | `ContextManager` | Access exchange history, cwd, search, expand |
| `getAcpClient` | `() => AcpClient` | Lazy getter for the agent client |
| `quit` | `() => void` | Exit agent-sh |
| `setPalette` | `(overrides) => void` | Override color palette slots for theming |
| `createBlockTransform` | `(opts) => void` | Register an inline delimiter transform (e.g. `$$...$$`) |
| `createFencedBlockTransform` | `(opts) => void` | Register a fenced block transform (e.g. ` ```lang...``` `) |
| `getExtensionSettings` | `(namespace, defaults) => T` | Read extension settings from `~/.agent-sh/settings.json` |
| `define` | `(name, fn) => void` | Register a named handler |
| `advise` | `(name, wrapper) => void` | Wrap a named handler (receives `next` + args) |
| `call` | `(name, ...args) => any` | Call a named handler |

All utilities are provided through `ctx` — no package imports needed. Extensions work from any location (`~/.agent-sh/extensions/`, npm packages, or local files).

### Extension Settings

Extensions read user-configurable settings from `~/.agent-sh/settings.json`, namespaced under the extension name with type-safe defaults:

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

## Named Handlers (Advice System)

Built-in extensions register named processing steps with `ctx.define`. User extensions wrap them with `ctx.advise` — each advisor receives the previous handler as `next` and decides whether to call it.

### How it works

```typescript
// tui-renderer defines the default code block handler
ctx.define("render:code-block", (language, code) => {
  syntaxHighlight(language, code);
});

// Your extension wraps it
ctx.advise("render:code-block", (next, language, code) => {
  if (language === "latex") {
    renderLatexImage(code);     // handle it yourself
    return;                     // don't call next — you replaced the handler
  }
  next(language, code);          // not yours — pass through to the original
});
```

The `next` parameter is the key. It's the previous handler (or the one before that, if multiple advisors chain). What you do with it determines the behavior:

```typescript
// AROUND — conditionally call the original
ctx.advise("render:code-block", (next, lang, code) => {
  if (lang === "mermaid") return renderMermaid(code);
  return next(lang, code);
});

// BEFORE — do something, then call the original
ctx.advise("render:code-block", (next, lang, code) => {
  console.log(`rendering: ${lang}`);
  return next(lang, code);
});

// AFTER — call the original, then do something
ctx.advise("render:code-block", (next, lang, code) => {
  const result = next(lang, code);
  logMetrics(lang, code.length);
  return result;
});

// OVERRIDE — replace entirely, never call next
ctx.advise("render:code-block", (_next, lang, code) => {
  return myCustomRenderer(lang, code);
});
```

### Available handlers

The tui-renderer registers these named handlers that extensions can advise:

| Handler | Arguments | Description |
|---|---|---|
| `render:code-block` | `(language: string, code: string)` | Render a fenced code block (default: syntax highlighting) |
| `render:image` | `(data: Buffer)` | Display an image in the terminal (default: iTerm2/Kitty protocol) |

### Multiple advisors chain

Each `advise` call wraps the previous handler. Multiple extensions can advise the same handler — they nest like middleware:

```
Extension A advises render:code-block (handles mermaid)
Extension B advises render:code-block (handles latex)
→ Call order: B's wrapper → A's wrapper → original handler
```

If B doesn't handle it (calls `next`), A gets a chance. If A doesn't handle it either, the original runs. First advisor to not call `next` wins.

### Defining your own handlers

Extensions can define their own named handlers for other extensions to advise:

```typescript
// my-extension defines a handler
ctx.define("my-ext:process-data", (data) => {
  return defaultProcessing(data);
});

// Call it from within your extension
const result = ctx.call("my-ext:process-data", someData);
```

Other extensions can then `advise("my-ext:process-data", ...)` to customize your behavior.

## Content Transform Pipeline

Agent response streams flow through a **transform pipeline** before any renderer sees them. Extensions can modify, replace, or enrich content — rendering LaTeX as images, replacing diagram blocks with graphics, filtering output, etc.

The tui-renderer is itself just an extension. **Nobody is special** — built-in and user extensions compose through the same primitives.

### Content blocks

The pipeline carries typed content blocks:

```typescript
type ContentBlock =
  | { type: "text"; text: string }                          // markdown text
  | { type: "code-block"; language: string; code: string }  // fenced code block
  | { type: "image"; data: Buffer }                         // PNG → terminal image protocol
  | { type: "raw"; escape: string }                         // raw terminal escape
```

The tui-renderer handles each type: text → markdown renderer, code-block → syntax highlighting, image → iTerm2/Kitty protocol, raw → direct stdout.

### Choosing the right tool

Extensions don't need to worry about pipe ordering or priorities. Each tool operates on its own domain and passes everything else through — they compose regardless of registration order.

| I want to... | Use | Operates on |
|---|---|---|
| Match inline delimiters (`$$`, `<<`, etc.) | `ctx.createBlockTransform` | text blocks |
| Match fenced blocks (` ``` `, `:::`, `~~~`) | `ctx.createFencedBlockTransform` | text blocks |
| Transform blocks others produced | `bus.onPipe("agent:response-chunk", ...)` | any block type |

### Inline delimiter transforms

`createBlockTransform` detects patterns like `$$...$$` in text blocks. It handles streaming buffering, chunk splitting, and flush-on-done:

```typescript
export default function activate(ctx) {
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
}
```

### Fenced block transforms

`createFencedBlockTransform` detects line-delimited fenced blocks. The open/close patterns are regexes, so it works for any fence style:

```typescript
// Detect :::warning ... ::: admonition blocks
ctx.createFencedBlockTransform({
  open: /^:::(\w+)\s*$/,
  close: /^:::\s*$/,
  transform(match, content) {
    const kind = match[1]; // "warning", "note", etc.
    return { type: "text", text: `⚠️ ${kind.toUpperCase()}: ${content}` };
  },
});
```

The tui-renderer uses this same primitive for standard ` ``` ` code fences — it's not special:

```typescript
ctx.createFencedBlockTransform({
  open: /^```(\w*)\s*$/,
  close: /^```\s*$/,
  transform(match, content) {
    return { type: "code-block", language: match[1] || "", code: content };
  },
});
```

### Claiming blocks from other transforms

To transform blocks that another extension produced (e.g. claim `code-block` with a specific language), use `bus.onPipe` directly:

```typescript
// Render mermaid code blocks as images
bus.onPipe("agent:response-chunk", (e) => {
  if (!e.blocks) return e;
  return {
    ...e,
    blocks: e.blocks.map(block => {
      if (block.type !== "code-block" || block.language !== "mermaid") return block;
      const png = renderMermaid(block.code);
      return png ? { type: "image", data: png } : block;
    }),
  };
});
```

### How composability works

Each tool only touches its own domain and passes everything else through:

```
createBlockTransform for $$   → reads text, produces images, passes code-blocks through
createFencedBlockTransform    → reads text, produces code-blocks, passes images through
onPipe claiming code-blocks   → reads code-blocks, produces images, passes text through
tui-renderer (on listener)    → renders whatever blocks remain
```

Order doesn't matter — they compose because each has a disjoint input type. No priority system, no phase declarations, no coordination between extensions.

### Example: LaTeX image rendering

`examples/extensions/latex-images.ts` renders both `$$...$$` and ` ```latex ` blocks as terminal images using `latex` + `dvipng`:

```bash
# Requires: latex + dvipng (brew install --cask mactex)
# Requires: iTerm2, WezTerm, Kitty, or Ghostty
agent-sh -e ./examples/extensions/latex-images.ts

# Or install permanently:
cp examples/extensions/latex-images.ts ~/.agent-sh/extensions/
```

```typescript
export default function activate(ctx: ExtensionContext) {
  const { bus } = ctx;
  const config = ctx.getExtensionSettings("latex-images", { dpi: 300, fgColor: "d4d4d4" });

  // Handle $$...$$ display math
  ctx.createBlockTransform({
    open: "$$", close: "$$",
    transform(latex) {
      const png = renderEquation(latex);
      return png ? [{ type: "text", text: "\n" }, { type: "image", data: png }] : null;
    },
  });

  // Handle ```latex code blocks
  bus.onPipe("agent:response-chunk", (e) => {
    if (!e.blocks) return e;
    return { ...e, blocks: e.blocks.map(block => {
      if (block.type !== "code-block") return block;
      if (block.language !== "latex" && block.language !== "tex") return block;
      const png = renderEquation(block.code);
      return png ? { type: "image", data: png } : block;
    })};
  });
}
```

## Yolo Mode

By default, agent-sh runs in **yolo mode** — all tool calls and file writes are auto-approved. This matches pi's design philosophy where the agent operates freely unless you explicitly add permission gates.

To add permission prompts, load the example extension:
```bash
# One-off
npm start -- -e ./examples/extensions/interactive-prompts.ts

# Permanent: copy to your extensions dir
cp examples/extensions/interactive-prompts.ts ~/.agent-sh/extensions/

# Or add to settings.json
echo '{ "extensions": ["./examples/extensions/interactive-prompts.ts"] }' > ~/.agent-sh/settings.json
```

## Theming

agent-sh uses a semantic color palette with ~10 base roles (`accent`, `success`, `warning`, `error`, `muted`, plus background variants and style modifiers). Extensions can override any slot via `setPalette()`:

```typescript
// solarized-theme.ts
export default function activate({ setPalette }) {
  setPalette({
    accent:  "\x1b[38;2;38;139;210m",   // solarized blue
    success: "\x1b[38;2;133;153;0m",    // solarized green
    warning: "\x1b[38;2;181;137;0m",    // solarized yellow
    error:   "\x1b[38;2;220;50;47m",    // solarized red
    muted:   "\x1b[38;2;88;110;117m",   // solarized base01
  });
}
```

Load a theme like any other extension:
```bash
npm start -- -e ./examples/extensions/solarized-theme.ts
```

## Loading Extensions

Extensions are loaded from three sources (in order, deduplicated):

**1. CLI flag (`-e` / `--extensions`)** — npm packages or file paths, repeatable:
```bash
npm start -- -e my-ext-package -e ./local-ext.ts
npm start -- -e my-ext-package,another-package   # comma-separated also works
```

**2. Settings file** — `~/.agent-sh/settings.json`:
```json
{
  "extensions": [
    "my-published-extension",
    "/absolute/path/to/ext.ts",
    "./relative/path/to/ext.js"
  ]
}
```

**3. Extensions directory** — files and directories in `~/.agent-sh/extensions/`:
```bash
~/.agent-sh/extensions/
├── my-extension.ts          # loaded directly
├── another.js               # JS works too
└── complex-extension/       # directory with index file
    ├── index.ts             # entry point (auto-detected)
    └── helpers.ts           # supporting modules
```

Extensions can be written in **TypeScript or JavaScript** — `.ts`, `.tsx`, `.mts`, `.js`, `.mjs` are all supported. TS extensions are transpiled at runtime via tsx.

Bare names (e.g. `my-ext-package`) resolve as **npm packages** via Node's standard module resolution. Install them globally or locally and reference by name.

Errors in extension loading are non-fatal — a `ui:error` is emitted and the next extension continues loading.
