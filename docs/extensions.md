# Extensions

## Writing Extensions

An extension is a module that exports a default (or named `activate`) function. It receives an `ExtensionContext` with access to all core services:

```typescript
// my-extension.js
export default function activate(ctx) {
  // Listen to agent events
  ctx.bus.on("agent:response-done", (e) => {
    console.log(`Agent responded with ${e.response.length} chars`);
  });

  // Add a slash command
  ctx.bus.on("command:execute", (e) => {
    if (e.name === "/greet") {
      ctx.bus.emit("ui:info", { message: "Hello from my extension!" });
    }
  });
  ctx.bus.onPipe("autocomplete:request", (payload) => {
    if (!payload.buffer.startsWith("/g")) return payload;
    return { ...payload, items: [...payload.items, { name: "/greet", description: "Say hello" }] };
  });

  // Intercept terminal commands
  ctx.bus.onPipe("agent:terminal-intercept", (payload) => {
    if (payload.command !== "my-tool") return payload;
    return { ...payload, intercepted: true, output: "custom output" };
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
| `setPalette` | `(overrides: Partial<ColorPalette>) => void` | Override color palette slots for theming |

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

A complete example is included at `examples/extensions/solarized-theme.ts`.

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
