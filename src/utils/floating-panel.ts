/**
 * Floating panel utility for overlay extensions.
 *
 * Provides a composited floating box rendered over the terminal using
 * an alternate screen buffer. Handles the full overlay lifecycle:
 * stdout hold/release, input routing, compositing, scroll, and
 * screen restore.
 *
 * Rendering is customizable via the handler/advise pattern:
 *
 *   // Define a custom content renderer
 *   ctx.define("panel:render-content", (renderCtx) => {
 *     return [`Hello from custom renderer (${renderCtx.width} cols)`];
 *   });
 *
 *   // Or wrap the default renderer
 *   ctx.advise("panel:render-content", (next, renderCtx) => {
 *     const lines = next(renderCtx);
 *     lines.push("── custom footer ──");
 *     return lines;
 *   });
 *
 * When @xterm/headless is needed (for dimmed background compositing):
 *   npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 *
 * Usage from extensions:
 *   import { FloatingPanel } from "agent-sh/utils/floating-panel.js";
 */
import { stripAnsi } from "./ansi.js";
import { LineEditor } from "./line-editor.js";
import { TerminalBuffer } from "./terminal-buffer.js";
import { HandlerRegistry } from "./handler-registry.js";
import type { EventBus } from "../event-bus.js";
import type { BorderStyle } from "./box-frame.js";

// ── ANSI constants ──────────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

// ── Border characters ───────────────────────────────────────────

const BORDERS: Record<BorderStyle, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  rounded: { tl: "\u256d", tr: "\u256e", bl: "\u2570", br: "\u256f", h: "\u2500", v: "\u2502" },
  square:  { tl: "\u250c", tr: "\u2510", bl: "\u2514", br: "\u2518", h: "\u2500", v: "\u2502" },
  double:  { tl: "\u2554", tr: "\u2557", bl: "\u255a", br: "\u255d", h: "\u2550", v: "\u2551" },
  heavy:   { tl: "\u250f", tr: "\u2513", bl: "\u2517", br: "\u251b", h: "\u2501", v: "\u2503" },
};

// ── Types ───────────────────────────────────────────────────────

export interface FloatingPanelConfig {
  /** Key sequence that toggles the panel (e.g. "\x1c" for Ctrl+\). */
  trigger: string;
  /** Panel width. Number = columns, string with % = percentage. Default: "80%". */
  width?: number | string;
  /** Max width in columns. Default: 100. */
  maxWidth?: number;
  /** Panel height. Number = rows, string with % = percentage. Default: "60%". */
  height?: number | string;
  /** Min content rows inside the panel. Default: 6. */
  minHeight?: number;
  /** Border style. Default: "rounded". */
  borderStyle?: BorderStyle;
  /**
   * Show dimmed terminal content behind the panel. Default: true.
   * Requires @xterm/headless — falls back to blank background if unavailable.
   */
  dimBackground?: boolean;
  /** Auto-dismiss delay in ms when done (0 = disabled). Default: 0. */
  autoDismissMs?: number;
  /** Icon shown before the input cursor. Default: "\u276f". */
  promptIcon?: string;
  /**
   * Pre-existing TerminalBuffer to reuse. If provided, the panel will
   * not create its own headless terminal. Useful when sharing a buffer
   * with other features (e.g. context injection, terminal_read tool).
   */
  terminalBuffer?: TerminalBuffer;
  /**
   * Handler namespace prefix. Default: "panel".
   * All handlers are registered as `{prefix}:render-content`,
   * `{prefix}:submit`, etc. Use different prefixes for multiple panels.
   */
  handlerPrefix?: string;
}

/**
 * Context passed to the render-content handler.
 */
export interface RenderContext {
  /** Available width for content (inside box, excluding borders and padding). */
  width: number;
  /** Available height for content (rows inside box). */
  height: number;
  /** Current panel phase. */
  phase: Phase;
  /** Current input buffer text (during input phase). */
  inputBuffer: string;
  /** Current input cursor position (during input phase). */
  inputCursor: number;
  /** Current scroll offset. */
  scrollOffset: number;
  /** Built-in content lines (from appendText/appendLine). */
  contentLines: readonly string[];
  /** Current partial line being streamed. */
  partialLine: string;
}

/**
 * Result from render-content handler.
 */
export interface RenderResult {
  lines: string[];
  /** Optional cursor position within the content area. */
  cursor?: { row: number; col: number };
}

export type Phase = "idle" | "input" | "active" | "done";

// ── FloatingPanel ───────────────────────────────────────────────

export class FloatingPanel {
  // ── Configuration ───────────────────────────────────────────
  private readonly config: Required<Omit<FloatingPanelConfig, "terminalBuffer">>;
  private readonly bus: EventBus;
  private readonly border: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  private readonly externalBuffer: TerminalBuffer | undefined;
  private readonly prefix: string;

  /**
   * Handler registry for this panel. Extensions use `handlers.advise()`
   * to customize rendering and behavior.
   *
   * Registered handlers:
   *   - `{prefix}:render-content(ctx: RenderContext) -> RenderResult`
   *   - `{prefix}:submit(query: string) -> void`
   *   - `{prefix}:dismiss() -> void`
   *   - `{prefix}:input(data: string) -> boolean`
   *   - `{prefix}:build-row(content: string, width: number) -> string`
   */
  readonly handlers: HandlerRegistry;

  // ── Headless terminal (lazy, optional) ──────────────────────
  private buffer: TerminalBuffer | null = null;
  private bufferInitialized = false;

  // ── State ───────────────────────────────────────────────────
  private phase: Phase = "idle";
  private editor = new LineEditor();
  private contentLines: string[] = [];
  private currentPartialLine = "";
  private scrollOffset = 0;
  private title = "";
  private footer = "";
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeHandler: (() => void) | null = null;
  private prevFrame: string[] = [];
  private dismissing = false;

  constructor(bus: EventBus, config: FloatingPanelConfig, handlers?: HandlerRegistry) {
    this.bus = bus;
    this.externalBuffer = config.terminalBuffer;
    this.prefix = config.handlerPrefix ?? "panel";
    this.handlers = handlers ?? new HandlerRegistry();
    this.config = {
      trigger: config.trigger,
      width: config.width ?? "80%",
      maxWidth: config.maxWidth ?? 100,
      height: config.height ?? "60%",
      minHeight: config.minHeight ?? 6,
      borderStyle: config.borderStyle ?? "rounded",
      dimBackground: config.dimBackground ?? true,
      autoDismissMs: config.autoDismissMs ?? 0,
      promptIcon: config.promptIcon ?? "\u276f",
      handlerPrefix: this.prefix,
    };
    this.border = BORDERS[this.config.borderStyle];

    // ── Register default handlers ─────────────────────────────
    const p = this.prefix;

    // Default content renderer: uses built-in appendText/appendLine buffer
    this.handlers.define(`${p}:render-content`, (ctx: RenderContext): RenderResult => {
      if (ctx.phase === "input") {
        return {
          lines: [`\x1b[36m${this.config.promptIcon}${RESET} ${ctx.inputBuffer}`],
          cursor: { row: 0, col: this.config.promptIcon.length + 1 + ctx.inputCursor },
        };
      }
      const all = [...ctx.contentLines, ...(ctx.partialLine ? [ctx.partialLine] : [])];
      // Auto-scroll
      let offset = ctx.scrollOffset;
      if (all.length > ctx.height) {
        offset = all.length - ctx.height;
      } else {
        offset = 0;
      }
      this.scrollOffset = offset;
      return { lines: all.slice(offset, offset + ctx.height) };
    });

    // Default submit: no-op (extension overrides)
    this.handlers.define(`${p}:submit`, (_query: string) => {});

    // Default dismiss: no-op
    this.handlers.define(`${p}:dismiss`, () => {});

    // Default custom input handler: don't consume
    this.handlers.define(`${p}:input`, (_data: string): boolean => false);

    // Default row builder: truncate and pad
    this.handlers.define(`${p}:build-row`, (content: string, width: number): string => {
      const plain = stripAnsi(content);
      const display = plain.length > width
        ? content.slice(0, width - 1) + "\u2026"
        : content;
      const pad = Math.max(0, width - stripAnsi(display).length);
      return display + " ".repeat(pad);
    });

    // ── Wire bus events ───────────────────────────────────────
    bus.onPipe("input:intercept", (payload) => this.handleIntercept(payload));
    bus.onPipe("shell:redraw-prompt", (payload) => {
      if (this.phase !== "idle" || this.dismissing) {
        return { ...payload, handled: true };
      }
      return payload;
    });
  }

  // ── Lazy terminal buffer setup ──────────────────────────────

  private ensureBuffer(): TerminalBuffer | null {
    if (this.bufferInitialized) return this.buffer;
    this.bufferInitialized = true;

    if (!this.config.dimBackground) return null;

    if (this.externalBuffer) {
      this.buffer = this.externalBuffer;
    } else {
      this.buffer = TerminalBuffer.createWired(this.bus);
    }

    return this.buffer;
  }

  // ── Public lifecycle ────────────────────────────────────────

  get active(): boolean {
    return this.phase !== "idle";
  }

  get terminalBuffer(): TerminalBuffer | null {
    return this.buffer;
  }

  open(): void {
    if (this.phase !== "idle") return;
    this.ensureBuffer();

    this.phase = "input";
    this.editor.clear();
    this.contentLines = [];
    this.currentPartialLine = "";
    this.scrollOffset = 0;
    this.title = "";
    this.footer = "";
    this.prevFrame = [];

    this.bus.emit("shell:stdout-hold", {});
    process.stdout.write("\x1b[?1049h");

    this.resizeHandler = () => { this.prevFrame = []; this.render(); };
    process.stdout.on("resize", this.resizeHandler);

    this.render();
  }

  dismiss(): void {
    if (this.phase === "idle") return;
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    if (this.autoDismissTimer) { clearTimeout(this.autoDismissTimer); this.autoDismissTimer = null; }
    if (this.resizeHandler) { process.stdout.off("resize", this.resizeHandler); this.resizeHandler = null; }

    // Set dismissing flag BEFORE going idle — suppresses shell:redraw-prompt
    // events that fire synchronously during stdout-release (freshPrompt \n).
    this.dismissing = true;
    this.phase = "idle";
    this.editor.clear();
    this.prevFrame = [];

    this.restoreScreen();

    this.bus.emit("shell:stdout-hide", {});
    this.bus.emit("shell:stdout-release", {});

    this.handlers.call(`${this.prefix}:dismiss`);

    // Clear flag after all synchronous handlers have run.
    // Use queueMicrotask so it clears before the next event loop tick
    // but after the current synchronous cascade.
    queueMicrotask(() => { this.dismissing = false; });
  }

  // ── Public content API ──────────────────────────────────────

  appendText(text: string): void {
    for (const ch of text) {
      if (ch === "\n") {
        this.contentLines.push(this.currentPartialLine);
        this.currentPartialLine = "";
      } else {
        this.currentPartialLine += ch;
      }
    }
    this.scheduleRender();
  }

  appendLine(line: string): void {
    if (this.currentPartialLine) {
      this.contentLines.push(this.currentPartialLine);
      this.currentPartialLine = "";
    }
    this.contentLines.push(line);
    this.scheduleRender();
  }

  updateLastLine(fn: (line: string) => string): void {
    if (this.contentLines.length > 0) {
      this.contentLines[this.contentLines.length - 1] = fn(this.contentLines[this.contentLines.length - 1]!);
    }
    this.scheduleRender();
  }

  clearContent(): void {
    this.contentLines = [];
    this.currentPartialLine = "";
    this.scrollOffset = 0;
    this.scheduleRender();
  }

  setTitle(title: string): void {
    this.title = title;
    this.scheduleRender();
  }

  setFooter(footer: string): void {
    this.footer = footer;
    this.scheduleRender();
  }

  setActive(): void {
    this.phase = "active";
  }

  setDone(): void {
    this.phase = "done";
    this.render();
    if (this.config.autoDismissMs > 0) {
      this.autoDismissTimer = setTimeout(() => {
        if (this.phase === "done") this.dismiss();
      }, this.config.autoDismissMs);
    }
  }

  getInput(): string {
    return this.editor.buffer;
  }

  requestRender(): void {
    this.scheduleRender();
  }

  // ── Input handling ──────────────────────────────────────────

  private handleIntercept(payload: { data: string; consumed: boolean }): { data: string; consumed: boolean } {
    if (this.phase === "done") {
      this.dismiss();
      return { ...payload, consumed: true };
    }

    if (this.phase === "input") {
      this.handleInputKey(payload.data);
      return { ...payload, consumed: true };
    }

    if (this.phase === "active") {
      const data = payload.data;
      if (data === "\x03") {
        this.bus.emit("agent:cancel-request", {});
        return { ...payload, consumed: true };
      }
      if (data === "\x1b" || data === this.config.trigger) {
        this.dismiss();
        return { ...payload, consumed: true };
      }
      if (this.handlers.call(`${this.prefix}:input`, data)) {
        return { ...payload, consumed: true };
      }
      return { ...payload, consumed: true };
    }

    if (payload.data === this.config.trigger) {
      this.open();
      return { ...payload, consumed: true };
    }

    return payload;
  }

  private handleInputKey(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b" && data[i + 1] == null) { this.dismiss(); return; }
      if (ch === this.config.trigger) { this.dismiss(); return; }
      if (ch.charCodeAt(0) === 0x03) { this.dismiss(); return; }
    }

    const actions = this.editor.feed(data);
    for (const action of actions) {
      switch (action.action) {
        case "submit": {
          const query = this.editor.buffer.trim();
          if (!query) { this.dismiss(); return; }
          this.phase = "active";
          this.editor.clear();
          this.handlers.call(`${this.prefix}:submit`, query);
          return;
        }
        case "cancel":
          this.dismiss();
          return;
        case "changed":
        case "tab":
        case "shift+tab":
        case "arrow-up":
        case "arrow-down":
        case "delete-empty":
          this.render();
          break;
      }
    }
  }

  // ── Frame building ────────────────────────────────────────

  private buildFrame(): { rows: string[]; cursorSeq: string } {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // Compute box geometry
    const boxW = Math.min(this.resolveSize(this.config.width, cols - 4), this.config.maxWidth);
    const boxH = Math.min(
      this.resolveSize(this.config.height, rows - 4),
      Math.max(this.config.minHeight + 2, rows - 4),
    );
    const boxTop = Math.floor((rows - boxH) / 2);
    const boxLeft = Math.floor((cols - boxW) / 2);
    const contentH = boxH - 2;
    const contentW = boxW - 4;

    // ── Call render-content handler ────────────────────────
    const ctx: RenderContext = {
      width: contentW,
      height: contentH,
      phase: this.phase,
      inputBuffer: this.editor.buffer,
      inputCursor: this.editor.cursor,
      scrollOffset: this.scrollOffset,
      contentLines: this.contentLines,
      partialLine: this.currentPartialLine,
    };
    const result: RenderResult = this.handlers.call(`${this.prefix}:render-content`, ctx);
    const visibleContent = result?.lines ?? [];
    const cursor = result?.cursor;

    // Pad content to fill height
    while (visibleContent.length < contentH) visibleContent.push("");

    // ── Get background ────────────────────────────────────
    const bgLines = this.buffer?.getScreenLines(rows) ?? null;

    // ── Compose each row ──────────────────────────────────
    const frame: string[] = [];
    const b = this.border;
    const dim = bgLines ? DIM : "";
    const buildRow = (content: string, w: number): string =>
      this.handlers.call(`${this.prefix}:build-row`, content, w);

    for (let row = 0; row < rows; row++) {
      const relRow = row - boxTop;
      let line: string;

      if (relRow < 0 || relRow >= boxH) {
        if (bgLines) {
          const bgLine = (bgLines[row] || "").padEnd(cols).slice(0, cols);
          line = `${dim}${bgLine}${RESET}\x1b[K`;
        } else {
          line = "\x1b[2K";
        }
      } else if (relRow === 0) {
        line = this.buildBorderTop(boxW, boxLeft, bgLines?.[row] ?? null, cols, b, dim);
      } else if (relRow === boxH - 1) {
        line = this.buildBorderBottom(boxW, boxLeft, bgLines?.[row] ?? null, cols, b, dim);
      } else {
        const contentIdx = relRow - 1;
        const raw = visibleContent[contentIdx] || "";
        const rendered = buildRow(raw, contentW);
        const boxLine = `${b.v} ${rendered} ${b.v}`;

        if (bgLines) {
          const bg = (bgLines[row] || "").padEnd(cols);
          line = `${dim}${bg.slice(0, boxLeft)}${RESET}${boxLine}${dim}${bg.slice(boxLeft + boxW)}${RESET}`;
        } else {
          line = boxLine;
        }
      }

      frame.push(line);
    }

    let cursorSeq = "";
    if (cursor) {
      const cursorRow = boxTop + 1 + cursor.row;
      const cursorCol = boxLeft + 2 + cursor.col;
      cursorSeq = `\x1b[${cursorRow + 1};${cursorCol + 1}H`;
    }

    return { rows: frame, cursorSeq };
  }

  private buildBorderTop(
    boxW: number, boxLeft: number, bgRow: string | null,
    cols: number, b: typeof this.border, dim: string,
  ): string {
    const titleText = this.title || (this.phase === "input" ? "input" : this.phase === "done" ? "done" : "...");
    const titleStr = ` ${INVERSE} ${titleText} ${RESET} `;
    const titleVisLen = titleText.length + 4; // text + 4 spaces (2 inside inverse, 2 outside)
    const dashCount = Math.max(0, boxW - titleVisLen - 3); // 3 = tl + h-before-title + tr
    const borderLine = `${b.tl}${b.h}${titleStr}${b.h.repeat(dashCount)}${b.tr}`;

    if (bgRow !== null) {
      const bg = bgRow.padEnd(cols);
      return `${dim}${bg.slice(0, boxLeft)}${RESET}${borderLine}${dim}${bg.slice(boxLeft + boxW)}${RESET}`;
    }
    return borderLine;
  }

  private buildBorderBottom(
    boxW: number, boxLeft: number, bgRow: string | null,
    cols: number, b: typeof this.border, dim: string,
  ): string {
    const footerText = this.footer || "";
    let borderLine: string;
    if (footerText) {
      const footerPad = Math.max(0, boxW - footerText.length - 3);
      borderLine = `${b.bl}${b.h.repeat(footerPad)}${DIM}${footerText}${RESET}${b.h}${b.br}`;
    } else {
      borderLine = `${b.bl}${b.h.repeat(boxW - 2)}${b.br}`;
    }

    if (bgRow !== null) {
      const bg = bgRow.padEnd(cols);
      return `${dim}${bg.slice(0, boxLeft)}${RESET}${borderLine}${dim}${bg.slice(boxLeft + boxW)}${RESET}`;
    }
    return borderLine;
  }

  // ── Rendering ─────────────────────────────────────────────

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 32);
  }

  private render(): void {
    if (this.phase === "idle") return;

    const { rows: frame, cursorSeq } = this.buildFrame();

    // Differential write — only send rows that changed
    const out: string[] = [SYNC_START];
    let dirty = false;

    for (let i = 0; i < frame.length; i++) {
      if (frame[i] !== this.prevFrame[i]) {
        out.push(`\x1b[${i + 1};1H`);
        out.push(frame[i]!);
        dirty = true;
      }
    }
    for (let i = frame.length; i < this.prevFrame.length; i++) {
      out.push(`\x1b[${i + 1};1H\x1b[2K`);
      dirty = true;
    }

    if (cursorSeq) out.push(cursorSeq);
    out.push(SYNC_END);

    if (this.prevFrame.length === 0 || dirty) {
      process.stdout.write(out.join(""));
    }

    this.prevFrame = frame;
  }

  // ── Screen helpers ────────────────────────────────────────

  private restoreScreen(): void {
    process.stdout.write("\x1b[?1049l");
    if (this.buffer) {
      const content = this.buffer.serialize();
      const cursor = this.buffer.getCursor();
      process.stdout.write(
        "\x1b[H\x1b[2J" + content +
        `\x1b[${cursor.y + 1};${cursor.x + 1}H`,
      );
    }
  }

  private resolveSize(spec: number | string, available: number): number {
    if (typeof spec === "number") return Math.min(spec, available);
    if (typeof spec === "string" && spec.endsWith("%")) {
      const pct = parseInt(spec, 10) / 100;
      return Math.floor(available * pct);
    }
    return available;
  }
}
