/**
 * Floating panel utility for overlay extensions.
 *
 * Provides a composited floating box rendered over the terminal using
 * an alternate screen buffer. Handles the full overlay lifecycle:
 * stdout hold/release, input routing, compositing, scroll, and
 * screen restore.
 *
 * Rendering is fully customizable via the handler/advise pattern:
 *
 *   // Replace the entire frame renderer
 *   panel.handlers.define("panel:render-frame", (ctx) => {
 *     // ctx has geo, content, bgLines, phase, title, footer, border
 *     return { rows: myCustomRows, cursorSeq: "" };
 *   });
 *
 *   // Or advise individual pieces
 *   panel.handlers.advise("panel:render-border-top", (next, ctx) => {
 *     return `┏━ ${ctx.title} ${"━".repeat(ctx.geo.boxW - ctx.title.length - 5)}┓`;
 *   });
 *
 *   panel.handlers.advise("panel:composite-row", (next, boxLine, bgLine, ...) => {
 *     // custom compositing (e.g. no dimming, blur effect, etc.)
 *     return next(boxLine, bgLine, ...);
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

/**
 * Box geometry computed from config + terminal size.
 */
export interface BoxGeometry {
  /** Terminal columns. */
  cols: number;
  /** Terminal rows. */
  rows: number;
  /** Box width in columns (including borders). */
  boxW: number;
  /** Box height in rows (including borders). */
  boxH: number;
  /** Box top offset (0-indexed row). */
  boxTop: number;
  /** Box left offset (0-indexed column). */
  boxLeft: number;
  /** Usable content width inside box. */
  contentW: number;
  /** Usable content height inside box. */
  contentH: number;
}

/**
 * Context passed to the render-frame handler.
 */
export interface FrameContext {
  /** Box geometry. */
  geo: BoxGeometry;
  /** Content render result (from render-content handler). */
  content: RenderResult;
  /** Background lines from the terminal buffer (null if no dimming). */
  bgLines: string[] | null;
  /** Current panel phase. */
  phase: Phase;
  /** Current title text. */
  title: string;
  /** Current footer text. */
  footer: string;
  /** Border characters for the configured border style. */
  border: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
}

/**
 * Result from render-frame handler.
 */
export interface FrameResult {
  /** One string per terminal row. */
  rows: string[];
  /** ANSI sequence to position the cursor (empty string if no cursor). */
  cursorSeq: string;
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
   *   - `{prefix}:render-frame(ctx: FrameContext) -> FrameResult`
   *   - `{prefix}:render-border-top(ctx: FrameContext) -> string`
   *   - `{prefix}:render-border-bottom(ctx: FrameContext) -> string`
   *   - `{prefix}:composite-row(content: string, bgLine: string|null, boxLeft: number, boxW: number, cols: number) -> string`
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
  private suppressNextRedraw = false;

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

    // Default border-top renderer
    this.handlers.define(`${p}:render-border-top`, (ctx: FrameContext): string => {
      const { geo, border: b, title: _unused } = ctx;
      const titleText = ctx.title || (ctx.phase === "input" ? "input" : ctx.phase === "done" ? "done" : "...");
      const titleStr = ` ${INVERSE} ${titleText} ${RESET} `;
      const titleVisLen = titleText.length + 4;
      const dashCount = Math.max(0, geo.boxW - titleVisLen - 3);
      return `${b.tl}${b.h}${titleStr}${b.h.repeat(dashCount)}${b.tr}`;
    });

    // Default border-bottom renderer
    this.handlers.define(`${p}:render-border-bottom`, (ctx: FrameContext): string => {
      const { geo, border: b } = ctx;
      if (ctx.footer) {
        const footerPad = Math.max(0, geo.boxW - ctx.footer.length - 3);
        return `${b.bl}${b.h.repeat(footerPad)}${DIM}${ctx.footer}${RESET}${b.h}${b.br}`;
      }
      return `${b.bl}${b.h.repeat(geo.boxW - 2)}${b.br}`;
    });

    // Default composite-row: merge content on top of dimmed background
    this.handlers.define(`${p}:composite-row`, (
      boxLine: string, bgLine: string | null, boxLeft: number, boxW: number, cols: number,
    ): string => {
      if (bgLine !== null) {
        const bg = bgLine.padEnd(cols);
        return `${DIM}${bg.slice(0, boxLeft)}${RESET}${boxLine}${DIM}${bg.slice(boxLeft + boxW)}${RESET}`;
      }
      return boxLine;
    });

    // Default frame renderer: assembles borders, content rows, and background
    this.handlers.define(`${p}:render-frame`, (ctx: FrameContext): FrameResult => {
      const { geo, content, bgLines, border: b } = ctx;
      const visibleContent = [...(content.lines ?? [])];
      while (visibleContent.length < geo.contentH) visibleContent.push("");

      const composite = (boxLine: string, bgLine: string | null): string =>
        this.handlers.call(`${p}:composite-row`, boxLine, bgLine, geo.boxLeft, geo.boxW, geo.cols);

      const buildRow = (c: string, w: number): string =>
        this.handlers.call(`${p}:build-row`, c, w);

      const frame: string[] = [];
      for (let row = 0; row < geo.rows; row++) {
        const relRow = row - geo.boxTop;
        if (relRow < 0 || relRow >= geo.boxH) {
          // Outside box
          if (bgLines) {
            frame.push(`${DIM}${(bgLines[row] || "").padEnd(geo.cols).slice(0, geo.cols)}${RESET}\x1b[K`);
          } else {
            frame.push("\x1b[2K");
          }
        } else if (relRow === 0) {
          const borderTop = this.handlers.call(`${p}:render-border-top`, ctx) as string;
          frame.push(composite(borderTop, bgLines?.[row] ?? null));
        } else if (relRow === geo.boxH - 1) {
          const borderBottom = this.handlers.call(`${p}:render-border-bottom`, ctx) as string;
          frame.push(composite(borderBottom, bgLines?.[row] ?? null));
        } else {
          const contentIdx = relRow - 1;
          const raw = visibleContent[contentIdx] || "";
          const rendered = buildRow(raw, geo.contentW);
          const boxLine = `${b.v} ${rendered} ${b.v}`;
          frame.push(composite(boxLine, bgLines?.[row] ?? null));
        }
      }

      let cursorSeq = "";
      if (content.cursor) {
        const cursorRow = geo.boxTop + 1 + content.cursor.row;
        const cursorCol = geo.boxLeft + 2 + content.cursor.col;
        cursorSeq = `\x1b[${cursorRow + 1};${cursorCol + 1}H`;
      }

      return { rows: frame, cursorSeq };
    });

    // ── Wire bus events ───────────────────────────────────────
    bus.onPipe("input:intercept", (payload) => this.handleIntercept(payload));
    bus.onPipe("shell:redraw-prompt", (payload) => {
      if (this.phase !== "idle") {
        return { ...payload, handled: true };
      }
      // After dismiss, suppress one redraw — restoreScreen already
      // restored the terminal content, so freshPrompt's \n is unwanted.
      if (this.suppressNextRedraw) {
        this.suppressNextRedraw = false;
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

    this.suppressNextRedraw = true;
    this.phase = "idle";
    this.editor.clear();
    this.prevFrame = [];

    this.restoreScreen();

    // Reset any accumulated stdout-show refs, then release hold.
    this.bus.emit("shell:stdout-hide", {});
    this.bus.emit("shell:stdout-release", {});

    this.handlers.call(`${this.prefix}:dismiss`);
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

  // ── Geometry ───────────────────────────────────────────────

  /** Compute box geometry from config + current terminal size. */
  computeGeometry(): BoxGeometry {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const boxW = Math.min(this.resolveSize(this.config.width, cols - 4), this.config.maxWidth);
    const boxH = Math.min(
      this.resolveSize(this.config.height, rows - 4),
      Math.max(this.config.minHeight + 2, rows - 4),
    );
    const boxTop = Math.floor((rows - boxH) / 2);
    const boxLeft = Math.floor((cols - boxW) / 2);
    return { cols, rows, boxW, boxH, boxTop, boxLeft, contentW: boxW - 4, contentH: boxH - 2 };
  }

  // ── Frame building ────────────────────────────────────────

  private buildFrame(): FrameResult {
    const geo = this.computeGeometry();

    // Call render-content handler
    const renderCtx: RenderContext = {
      width: geo.contentW,
      height: geo.contentH,
      phase: this.phase,
      inputBuffer: this.editor.buffer,
      inputCursor: this.editor.cursor,
      scrollOffset: this.scrollOffset,
      contentLines: this.contentLines,
      partialLine: this.currentPartialLine,
    };
    const content: RenderResult = this.handlers.call(`${this.prefix}:render-content`, renderCtx);

    // Get background
    const bgLines = this.buffer?.getScreenLines(geo.rows) ?? null;

    // Build frame context and delegate to render-frame handler
    const frameCtx: FrameContext = {
      geo,
      content,
      bgLines,
      phase: this.phase,
      title: this.title,
      footer: this.footer,
      border: this.border,
    };

    return this.handlers.call(`${this.prefix}:render-frame`, frameCtx);
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
    // Leave alt screen — the terminal restores the saved main buffer.
    // We intentionally do NOT rewrite from the xterm buffer here:
    // the xterm only sees PTY data, not direct stdout writes (banner,
    // TUI output, etc.), so its content doesn't match the real screen.
    process.stdout.write("\x1b[?1049l");
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
