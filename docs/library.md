# Using agent-sh as a Library

## Library vs Extension

agent-sh has two integration points. The difference: **extensions customize the existing TUI**, while **library mode lets you build your own frontend**.

| | Extension | Library |
|---|---|---|
| **Use when** | You want to add features to the interactive terminal — themes, custom renderers, input modes, content transforms | You're building something else entirely — a REST API, Electron app, test harness, CI pipeline |
| **You get** | `ExtensionContext` — bus, rendering hooks, `setPalette`, `createBlockTransform`, named handlers | `AgentShellCore` — bus, `query()`, lifecycle control (`activateBackend`, `kill`) |
| **Who controls the frontend?** | The built-in TUI does; you decorate it | You do; there is no TUI |
| **How to use** | Export an `activate` function, load with `-e` | Import `createCore()`, load extensions, wire your own I/O |

If you're adding a Mermaid renderer or a custom slash command, write an extension. If you're building a web server that talks to an LLM, use the library.

## Quick Start

```typescript
import { createCore } from "agent-sh";
import { loadBuiltinExtensions } from "agent-sh/builtin-extensions";

const core = createCore({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o",
});

const extCtx = core.extensionContext({ quit: () => process.exit(0) });

// Load the built-in agent backend + other built-in extensions
await loadBuiltinExtensions(extCtx);

// Subscribe to events
core.bus.on("agent:response-chunk", ({ blocks }) => {
  for (const b of blocks) if (b.type === "text") process.stdout.write(b.text);
});
core.bus.on("agent:processing-done", () => console.log("\n[done]"));

// Handle permissions (auto-approve, or wire to your own UI)
core.bus.onPipeAsync("permission:request", async (p) => {
  return { ...p, decision: { approved: true } };
});

// Activate the backend, then send a query
core.activateBackend();
const response = await core.query("explain this codebase");
```

`createCore()` returns a headless kernel — the event bus, context manager, handler registry, and compositor, with no terminal, LLM, or agent attached. You load extensions (including the agent backend) and wire your own I/O by listening to bus events.

## AgentShellCore API

| Method | Description |
|---|---|
| `bus` | The event bus — same one extensions use. See [Extensions: Event Bus](extensions.md#event-bus) |
| `contextManager` | Access exchange history, working directory, context assembly |
| `handlers` | Named handler registry for `define`/`advise`/`call` |
| `query(text, opts?)` | Convenience wrapper: emits `agent:submit`, collects response chunks, resolves with the full text |
| `activateBackend()` | Activates the chosen agent backend. Call after loading extensions |
| `extensionContext(opts)` | Creates an `ExtensionContext` — use this to load extensions in library mode |
| `cancel()` | Cancel the current agent request |
| `kill()` | Clean shutdown |

## Loading Extensions in Library Mode

Extensions aren't loaded automatically in library mode — you get a bare kernel with no agent. You must load extensions to get an agent backend:

```typescript
import { createCore } from "agent-sh";
import { loadBuiltinExtensions } from "agent-sh/builtin-extensions";

const core = createCore({ apiKey: "...", model: "gpt-4o" });
const extCtx = core.extensionContext({ quit: () => process.exit(0) });

// Load built-in extensions (includes agent-backend, tui-renderer, etc.)
// Optionally disable specific ones:
await loadBuiltinExtensions(extCtx, ["tui-renderer", "overlay-agent"]);

// Load your own extensions
import myTheme from "./my-theme";
myTheme(extCtx);

// Then activate the backend (always call this last)
core.activateBackend();
```

This is exactly what the CLI does internally: `createCore()` → load built-in extensions → load user extensions → `activateBackend()`. The interactive terminal is just another layer on top of the same kernel.

See [Architecture](architecture.md) for details on the core design and EventBus.
