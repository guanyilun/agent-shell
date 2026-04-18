/**
 * Compositor — routes named render streams to surfaces.
 *
 * Components write to named streams ("agent", "query", "status").
 * The compositor decides where each stream actually goes based on
 * the current routing table.  Extensions override routing with
 * `redirect()` to capture output (e.g. overlay panels).
 *
 * Streams are hierarchical: "agent:diff" falls back to "agent" if
 * no override or default is registered for "agent:diff" specifically.
 * This enables fine-grained interception — redirect just diffs into
 * a panel, or just a subagent's output ("agent:sub:abc123"), while
 * everything else flows to the parent stream's surface.
 *
 *   // tui-renderer registers default surfaces
 *   compositor.setDefault("agent", stdoutSurface);
 *
 *   // overlay-agent redirects when active
 *   const restore = compositor.redirect("agent", panelSurface);
 *   // ... later ...
 *   restore();  // back to stdout
 *
 *   // fine-grained: redirect only diffs to a viewer panel
 *   compositor.redirect("agent:diff", diffPanelSurface);
 *   // "agent:text", "agent:tool" etc. still go to stdout
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { EventBus } from "../event-bus.js";

/**
 * A surface accepts rendered output.  Stdout is a surface.
 * A floating panel's content area is a surface.  A test buffer is a surface.
 */
export interface RenderSurface {
  /** Raw write — supports \r, partial lines, escape codes. */
  write(text: string): void;
  /** Convenience: write + newline. */
  writeLine(line: string): void;
  /** Available width in columns. */
  readonly columns: number;
}

export interface Compositor {
  /** Get the currently active surface for a stream. */
  surface(stream: string): RenderSurface;

  /** Override routing: redirect a stream to a different surface.
   *  Returns a restore function that undoes the redirect. */
  redirect(stream: string, target: RenderSurface): () => void;

  /** Register the default surface for a stream. */
  setDefault(stream: string, target: RenderSurface): void;
}

/** Silent sink — drops all output. Used when no surface is registered. */
export const nullSurface: RenderSurface = {
  write() {},
  writeLine() {},
  get columns() { return 80; },
};

/** Surface backed by process.stdout. */
export class StdoutSurface implements RenderSurface {
  write(text: string): void {
    if (process.stdout.writable) {
      try { process.stdout.write(text); } catch { /* ignore */ }
    }
  }
  writeLine(line: string): void {
    this.write(line + "\n");
  }
  get columns(): number {
    return process.stdout.columns || 80;
  }
}

export class DefaultCompositor implements Compositor {
  private defaults = new Map<string, RenderSurface>();
  private overrides = new Map<string, RenderSurface[]>();
  private readonly bus?: EventBus;

  constructor(bus?: EventBus) {
    this.bus = bus;
  }

  surface(stream: string): RenderSurface {
    const stack = this.overrides.get(stream);
    if (stack && stack.length > 0) return stack[stack.length - 1]!;
    if (this.defaults.has(stream)) return this.defaults.get(stream)!;

    // Hierarchical fallback: "agent:diff" → "agent"
    const colon = stream.lastIndexOf(":");
    if (colon !== -1) return this.surface(stream.slice(0, colon));

    return nullSurface;
  }

  redirect(stream: string, target: RenderSurface): () => void {
    const wrapped = this.wrap(stream, target);
    let stack = this.overrides.get(stream);
    if (!stack) {
      stack = [];
      this.overrides.set(stream, stack);
    }
    stack.push(wrapped);

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      const s = this.overrides.get(stream);
      if (!s) return;
      const idx = s.indexOf(wrapped);
      if (idx !== -1) s.splice(idx, 1);
    };
  }

  setDefault(stream: string, target: RenderSurface): void {
    this.defaults.set(stream, this.wrap(stream, target));
  }

  /** Wrap a surface so writes emit `compositor:write` before delegating. */
  private wrap(stream: string, target: RenderSurface): RenderSurface {
    const bus = this.bus;
    if (!bus) return target;
    return {
      write: (text: string) => {
        try { bus.emit("compositor:write", { stream, text }); } catch {}
        target.write(text);
      },
      writeLine: (line: string) => {
        try { bus.emit("compositor:write", { stream, text: line + "\n" }); } catch {}
        target.writeLine(line);
      },
      get columns() { return target.columns; },
    };
  }
}
