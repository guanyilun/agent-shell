/**
 * Named handler registry with Emacs-style advice.
 *
 * Built-in extensions register named handlers with `define`.
 * User extensions wrap them with `advise` — each advisor receives
 * `next` (the previous handler) and decides whether to call it.
 *
 *   registry.define("render:code-block", (lang, code) => highlight(lang, code));
 *
 *   registry.advise("render:code-block", (next, lang, code) => {
 *     if (lang === "latex") return renderLatex(code);
 *     return next(lang, code);  // call original
 *   });
 *
 * Internally, each handler is stored as a base function plus an ordered
 * list of advisors. `call` builds the chain on invocation, so advisors
 * can be added or removed at any time without closure entanglement.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type HandlerFn = (...args: any[]) => any;
type Advisor = (next: HandlerFn, ...args: any[]) => any;

interface HandlerEntry {
  base: HandlerFn;
  advisors: Advisor[];
}

/** The subset of HandlerRegistry methods available to extensions. */
export interface HandlerFunctions {
  define(name: string, fn: (...args: any[]) => any): void;
  advise(name: string, advisor: (next: (...args: any[]) => any, ...args: any[]) => any): () => void;
  call(name: string, ...args: any[]): any;
  list(): string[];
}

export class HandlerRegistry {
  private entries = new Map<string, HandlerEntry>();

  /**
   * Register a named handler. If one already exists, its base is replaced
   * but existing advisors are preserved.
   */
  define(name: string, fn: HandlerFn): void {
    const existing = this.entries.get(name);
    if (existing) {
      existing.base = fn;
    } else {
      this.entries.set(name, { base: fn, advisors: [] });
    }
  }

  /**
   * Add an advisor to a named handler. The advisor receives `next`
   * (the rest of the chain) and all original arguments.
   *
   * - Call `next(...args)` to invoke the rest of the chain
   * - Don't call `next` to replace entirely (override)
   * - Call `next` conditionally to wrap (around)
   *
   * Advisors run outermost-first (last added = outermost).
   * Returns an unadvise function that cleanly removes this advisor.
   */
  advise(name: string, advisor: Advisor): () => void {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { base: (() => undefined) as any, advisors: [] };
      this.entries.set(name, entry);
    }
    entry.advisors.push(advisor);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const e = this.entries.get(name);
      if (!e) return;
      const idx = e.advisors.indexOf(advisor);
      if (idx !== -1) e.advisors.splice(idx, 1);
    };
  }

  /**
   * Call a named handler. Builds the advisor chain on each call:
   * outermost advisor wraps the next, down to the base handler.
   * Returns undefined if no handler is registered.
   */
  call(name: string, ...args: any[]): any {
    const entry = this.entries.get(name);
    if (!entry) return undefined;

    // Build chain: base ← advisor[0] ← advisor[1] ← ... ← advisor[n-1]
    let fn: HandlerFn = entry.base;
    for (const advisor of entry.advisors) {
      const next = fn;
      fn = (...a: any[]) => advisor(next, ...a);
    }
    return fn(...args);
  }

  /**
   * Check if a named handler exists.
   */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Names of all registered handlers. For diagnostic/introspection use.
   */
  list(): string[] {
    return [...this.entries.keys()];
  }
}
