# TUI Composition

How agent-sh routes rendered output to different surfaces (stdout, floating panels, test buffers) and how extensions intercept or redirect that output.

## Overview

The TUI rendering pipeline has three layers:

1. **Components** — know *what* to render. Pure functions that turn state into `string[]`. Examples: `renderBoxFrame()`, `renderDiff()`, `renderToolCall()`.

2. **Surfaces** — know *where* output goes. A surface accepts lines and raw writes. Stdout is a surface. A floating panel's content area is a surface.

3. **Compositor** — knows *how to route*. Maps named streams to surfaces. Extensions override routing with `redirect()` to capture output.

```
                    ┌─────────────────┐
 EventBus events    │  tui-renderer   │  (subscribes to agent:* events,
  agent:query  ───► │                 │   manages state, calls components)
  agent:chunk  ───► │  RenderState    │
  agent:tool-* ───► │  MarkdownRender │
                    └───────┬─────────┘
                            │ writes to named streams
                            ▼
                    ┌─────────────────┐
                    │   Compositor    │  routes streams → surfaces
                    │                 │
                    │ "agent"  ──► ?  │
                    │ "query"  ──► ?  │
                    │ "status" ──► ?  │
                    └───────┬─────────┘
                            │ resolves to active surface
                    ┌───────┴─────────────────────┐
                    ▼                             ▼
             ┌─────────────┐              ┌──────────────┐
             │ StdoutSurface│              │ PanelSurface │
             │ (default)    │              │ (override)   │
             └─────────────┘              └──────────────┘
```

## Surfaces

A `RenderSurface` is anything that can accept rendered output:

```typescript
interface RenderSurface {
  write(text: string): void;    // raw — supports \r, escape codes
  writeLine(line: string): void; // line + newline
  readonly columns: number;      // available width
}
```

Built-in surfaces:

| Surface | Description |
|---|---|
| `StdoutSurface` | Default. Writes to `process.stdout`. |
| `nullSurface` | Drops all output silently. Used when no route exists. |

Extensions create their own surfaces. For example, a floating panel surface:

```typescript
const panelSurface: RenderSurface = {
  write(text) {
    if (text.startsWith("\r")) {
      // Handle spinner \r overwrites
      const cleaned = text.replace(/^\r/, "").replace(/\x1b\[\d*K/g, "");
      if (cleaned.trim()) panel.updateLastLine(() => cleaned);
      return;
    }
    panel.appendText(text);
  },
  writeLine(line) { panel.appendLine(line); },
  get columns() { return panel.computeGeometry().contentW; },
};
```

## Compositor

The compositor maps named streams to surfaces. Components write to streams — they never know (or care) which surface they end up on.

```typescript
interface Compositor {
  surface(stream: string): RenderSurface;
  redirect(stream: string, target: RenderSurface): () => void;
  setDefault(stream: string, target: RenderSurface): void;
}
```

### Default streams

| Stream | Content |
|---|---|
| `"agent"` | Agent response: markdown, tool calls, spinner, diffs, code blocks |
| `"query"` | User query display (the bordered input box) |
| `"status"` | Info messages, errors, suggestions |

All three default to `StdoutSurface`.

### Redirecting a stream

`redirect()` returns a restore function. Redirects are stack-based — multiple redirects on the same stream nest correctly:

```typescript
const restore = compositor.redirect("agent", panelSurface);
// ... agent output now goes to the panel ...
restore(); // back to previous surface
```

### Hierarchical streams

Stream names are hierarchical, separated by `:`. When resolving a surface, the compositor walks up the hierarchy until it finds an override or default:

```
"agent:sub:abc123"  →  "agent:sub"  →  "agent"  →  nullSurface
```

This enables fine-grained interception without registering defaults for every sub-stream:

```typescript
// All agent output goes to stdout (the "agent" default)
compositor.setDefault("agent", stdoutSurface);

// Redirect just diffs to a viewer panel — everything else unaffected
compositor.redirect("agent:diff", diffPanelSurface);

// Redirect a specific subagent to its own panel
compositor.redirect("agent:sub:abc123", subagentPanelSurface);
```

The tui-renderer writes to the appropriate sub-stream. If no override exists for that sub-stream, output falls through to the parent — which is typically stdout.

## Writing an extension that uses the compositor

### Example: overlay agent (full redirect)

The overlay agent redirects *all* render streams to a floating panel when active. This is the simplest pattern — whole-sale capture:

```typescript
export default function activate(ctx: ExtensionContext): void {
  const { bus, compositor, createFloatingPanel } = ctx;

  const panel = createFloatingPanel({ trigger: "\x1c" });
  const panelSurface = createPanelSurface(panel);

  let restoreAgent: (() => void) | null = null;
  let restoreQuery: (() => void) | null = null;

  panel.handlers.advise("panel:submit", (_next, query: string) => {
    restoreAgent = compositor.redirect("agent", panelSurface);
    restoreQuery = compositor.redirect("query", panelSurface);
    panel.setActive();
    bus.emit("agent:submit", { query });
  });

  panel.handlers.advise("panel:dismiss", (next) => {
    next();
    restoreAgent?.(); restoreAgent = null;
    restoreQuery?.(); restoreQuery = null;
  });
}
```

Because the full tui-renderer pipeline still runs — it just writes to the panel surface instead of stdout — the overlay gets markdown rendering, tool grouping, diffs, and syntax highlighting for free.

### Example: diff viewer (sub-stream redirect)

An extension that captures just diff output into a separate panel:

```typescript
export default function activate(ctx: ExtensionContext): void {
  const { compositor, createFloatingPanel } = ctx;

  const panel = createFloatingPanel({ trigger: "\x04" }); // Ctrl+D
  const surface = createPanelSurface(panel);

  panel.handlers.advise("panel:show", (_next) => {
    // Redirect just the diff sub-stream
    compositor.redirect("agent:diff", surface);
  });
}
```

Main agent output (text, tools, spinner) continues on stdout. Only diffs route to the panel.

### Example: subagent panel

A panel that shows a subagent's work separately from the main agent:

```typescript
function onSubagentSpawn(id: string, ctx: ExtensionContext): void {
  const panel = ctx.createFloatingPanel({ dimBackground: false });
  const surface = createPanelSurface(panel);

  // This subagent's output goes to its own panel
  const restore = ctx.compositor.redirect(`agent:sub:${id}`, surface);

  panel.open();
  // When done, restore routing
  ctx.bus.on("agent:processing-done", () => {
    restore();
    panel.setDone();
  });
}
```

## How tui-renderer uses the compositor

The tui-renderer gets the compositor from `ExtensionContext` and writes to named streams instead of stdout directly:

```typescript
export default function activate(ctx: ExtensionContext): void {
  const { compositor } = ctx;

  // Shorthand — get the current agent surface
  function out(): RenderSurface {
    return compositor.surface("agent");
  }

  // Drain markdown renderer lines to the active surface
  function drain(): void {
    const surface = out();
    for (const line of renderer.drainLines()) {
      surface.writeLine(line);
    }
  }

  // Spinner writes directly to the surface
  setInterval(() => {
    out().write(`\r  ${spinnerLine}\x1b[K`);
  }, 80);
}
```

The renderer doesn't know whether it's writing to stdout or a panel. The compositor resolves the target on each `surface()` call, so redirects take effect immediately — even mid-response.

## Remote sessions

For most extensions that route output to a different surface, use `createRemoteSession()` instead of manual compositor redirects. It bundles compositor routing, shell lifecycle advisors, and chrome suppression into one call:

```typescript
const session = ctx.createRemoteSession({
  surface: panelSurface,
  suppressQueryBox: true,   // session has own input
  interactive: true,         // enable terminal_read/terminal_keys context
});

session.submit("what's on screen?");
session.close();  // restores everything
```

See [Extensions: Remote Sessions](extensions.md#remote-sessions) for the full API.

Use the compositor directly only when you need fine-grained control — e.g. redirecting a single sub-stream like `"agent:diff"` without affecting the rest.

## Relationship to other systems

| System | Role | Compositor interaction |
|---|---|---|
| **EventBus** | Delivers agent events to tui-renderer | None — events flow regardless of where output goes |
| **Handler registry** | Advisable render functions (`render:code-block`, etc.) | Handlers produce lines; compositor routes them to surfaces |
| **FloatingPanel** | Screen compositing, input routing, alt-screen management | Panel provides the surface; compositor routes to it |
| **MarkdownRenderer** | Streaming markdown → lines | Produces lines; tui-renderer drains them to compositor surface |
| **RemoteSession** | High-level "route output elsewhere" primitive | Creates compositor redirects + lifecycle advisors in one call |

The compositor sits between "produce lines" and "display lines". It doesn't affect *what* gets rendered — only *where*.

## Key files

| File | Role |
|---|---|
| `src/utils/compositor.ts` | `RenderSurface`, `Compositor`, `DefaultCompositor`, `StdoutSurface` |
| `src/extensions/tui-renderer.ts` | Main renderer — writes to compositor streams |
| `src/extensions/overlay-agent.ts` | Uses `createRemoteSession` to route to floating panel |
| `src/utils/floating-panel.ts` | Panel screen management and content API |
| `src/core.ts` | Creates compositor, registers default surfaces, implements `createRemoteSession` |
| `src/types.ts` | `ExtensionContext.compositor`, `RemoteSession`, `RemoteSessionOptions` |
| `examples/extensions/tmux-pane.ts` | Tmux side pane — `/split` and `/rsplit` using `createRemoteSession` |
