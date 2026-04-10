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
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class HandlerRegistry {
  private handlers = new Map<string, (...args: any[]) => any>();

  /**
   * Register a named handler. If one already exists, it's replaced.
   */
  define(name: string, fn: (...args: any[]) => any): void {
    this.handlers.set(name, fn);
  }

  /**
   * Wrap a named handler with advice. The wrapper receives the
   * previous handler as `next` and all original arguments.
   *
   * - Call `next(...args)` to invoke the original (around/before/after)
   * - Don't call `next` to replace entirely (override)
   * - Call `next` conditionally to wrap (around)
   *
   * Multiple advisors chain: each wraps the previous one.
   * If no handler exists yet, `next` is a no-op.
   */
  advise(name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any): void {
    const original = this.handlers.get(name) ?? ((() => undefined) as any);
    this.handlers.set(name, (...args: any[]) => wrapper(original, ...args));
  }

  /**
   * Call a named handler. Returns undefined if no handler is registered.
   */
  call(name: string, ...args: any[]): any {
    const fn = this.handlers.get(name);
    return fn?.(...args);
  }

  /**
   * Check if a named handler exists.
   */
  has(name: string): boolean {
    return this.handlers.has(name);
  }
}
