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
import { wrapLine } from "./markdown.js";
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

// ── Trigger sequence helpers ────────────────────────────────────
// Programs like vim enable xterm's modifyOtherKeys or the kitty
// keyboard protocol, which encode Ctrl+key as CSI sequences instead
// of raw control bytes.  We pre-compute every encoding of the
// trigger so it works regardless of what the foreground process has
// negotiated with the terminal.

function buildTriggerSequences(trigger: string): string[] {
  const seqs = [trigger];
  if (trigger.length === 1) {
    const code = trigger.charCodeAt(0);
    if (code < 32) {
      // Ctrl+key: base codepoint is code | 0x40 (e.g. 0x1c → 0x5c = '\')
      const base = code | 0x40;
      // xterm modifyOtherKeys mode 2: ESC[27;5;<base>~
      seqs.push(`\x1b[27;5;${base}~`);
      // kitty keyboard protocol: ESC[<base>;5u
      seqs.push(`\x1b[${base};5u`);
    }
  }
  return seqs;
}

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
  /** Auto-dismiss delay in ms when done (0 = auto-prompt for follow-up). Default: 0. */
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
   *   - `{prefix}:show() -> void`
   *   - `{prefix}:input(data: string) -> boolean`
   *   - `{prefix}:build-row(content: string, width: number) -> string`
   */
  readonly handlers: HandlerRegistry;

  // ── Headless terminal (lazy, optional) ──────────────────────
  private buffer: TerminalBuffer | null = null;
  private bufferInitialized = false;

  // ── Trigger sequences ───────────────────────────────────────
  /** All byte sequences that should be recognized as the trigger key. */
  private readonly triggerSeqs: string[];

  // ── State ───────────────────────────────────────────────────
  private phase: Phase = "idle";
  private _visible = false;  // whether the panel box is shown on screen
  private _passthrough = false;  // hidden but still rendering TerminalBuffer
  private editor = new LineEditor();
  private contentLines: string[] = [];
  private currentPartialLine = "";
  private scrollOffset = 0;
  private userScrolled = false;  // true when user manually scrolled away from bottom
  private title = "";
  private footer = "";
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeHandler: (() => void) | null = null;
  private prevFrame: string[] = [];
  private suppressNextRedraw = false;
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private ptyBuffer = "";  // PTY output accumulated while overlay is open
  private usedAltScreen = false;  // whether we entered our own alt screen
  private wrapCache = new Map<string, string[]>();  // line → wrapped lines (invalidated on width change)
  private wrapCacheWidth = 0;
  private passthroughTimer: ReturnType<typeof setInterval> | null = null;
  private prevSerialized = "";

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
    this.triggerSeqs = buildTriggerSequences(config.trigger);

    this.registerDefaultHandlers();
    this.wireEvents();
  }

  // ── Default handler registration ───────────────────────────

  private registerDefaultHandlers(): void {
    const p = this.prefix;

    // Default content renderer: uses built-in appendText/appendLine buffer
    this.handlers.define(`${p}:render-content`, (ctx: RenderContext): RenderResult => {
      const raw = [...ctx.contentLines, ...(ctx.partialLine ? [ctx.partialLine] : [])];

      // Invalidate wrap cache if width changed
      if (ctx.width !== this.wrapCacheWidth) {
        this.wrapCache.clear();
        this.wrapCacheWidth = ctx.width;
      }

      const all: string[] = [];
      for (const line of raw) {
        let wrapped = this.wrapCache.get(line);
        if (!wrapped) {
          wrapped = wrapLine(line, ctx.width);
          this.wrapCache.set(line, wrapped);
        }
        all.push(...wrapped);
      }

      // In input phase, append the prompt line at the bottom of content
      if (ctx.phase === "input") {
        const promptLine = `\x1b[36m${this.config.promptIcon}${RESET} ${ctx.inputBuffer}`;
        all.push(promptLine);
      }

      // Scroll: auto-scroll to bottom unless user manually scrolled
      let offset = ctx.scrollOffset;
      const maxOffset = Math.max(0, all.length - ctx.height);
      if (this.userScrolled) {
        offset = Math.min(offset, maxOffset);
        // Resume auto-scroll if user scrolled back to bottom
        if (offset >= maxOffset) this.userScrolled = false;
      } else {
        offset = maxOffset;
      }
      this.scrollOffset = offset;

      const visible = all.slice(offset, offset + ctx.height);

      // Cursor position for input mode
      if (ctx.phase === "input") {
        const promptRow = visible.length - 1;
        // If prompt is visible, set cursor
        if (promptRow >= 0) {
          return {
            lines: visible,
            cursor: { row: promptRow, col: this.config.promptIcon.length + 1 + ctx.inputCursor },
          };
        }
      }

      return { lines: visible };
    });

    // Default submit: no-op (extension overrides)
    this.handlers.define(`${p}:submit`, (_query: string) => {});

    // Default dismiss: no-op
    this.handlers.define(`${p}:dismiss`, () => {});

    // Default show: no-op (extension overrides to rebuild content on re-show)
    this.handlers.define(`${p}:show`, () => {});

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
      const { geo, border: b } = ctx;
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
        const visLen = stripAnsi(ctx.footer).length;
        const footerPad = Math.max(0, geo.boxW - visLen - 3);
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

      const composite = (boxLine: string, bg: string | null): string =>
        this.handlers.call(`${p}:composite-row`, boxLine, bg, geo.boxLeft, geo.boxW, geo.cols);

      const buildRow = (c: string, w: number): string =>
        this.handlers.call(`${p}:build-row`, c, w);

      const frame: string[] = [];
      for (let row = 0; row < geo.rows; row++) {
        const relRow = row - geo.boxTop;
        const bg = bgLines?.[row] ?? null;

        if (relRow < 0 || relRow >= geo.boxH) {
          // Outside box
          if (bgLines) {
            frame.push(`${DIM}${(bgLines[row] || "").padEnd(geo.cols).slice(0, geo.cols)}${RESET}\x1b[K`);
          } else {
            frame.push("\x1b[2K");
          }
        } else if (relRow === 0) {
          frame.push(composite(this.handlers.call(`${p}:render-border-top`, ctx), bg));
        } else if (relRow === geo.boxH - 1) {
          frame.push(composite(this.handlers.call(`${p}:render-border-bottom`, ctx), bg));
        } else {
          const raw = visibleContent[relRow - 1] || "";
          const boxLine = `${b.v} ${buildRow(raw, geo.contentW)} ${b.v}`;
          frame.push(composite(boxLine, bg));
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
  }

  // ── Bus event wiring ───────────────────────────────────────

  private wireEvents(): void {
    // Buffer PTY output while overlay is visible (alt screen discards it).
    // Don't buffer when hidden — PTY flows to terminal directly via stdout-show.
    this.bus.on("shell:pty-data", ({ raw }) => {
      if (this._visible) this.ptyBuffer += raw;
    });

    this.bus.onPipe("input:intercept", (payload) => this.handleIntercept(payload));
    this.bus.onPipe("shell:redraw-prompt", (payload) => {
      if (this._visible || this._passthrough) {
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

  /** Check whether data matches any encoding of the trigger key. */
  private isTrigger(data: string): boolean {
    return this.triggerSeqs.includes(data);
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

  /** Whether the panel has an active conversation (may be hidden). */
  get active(): boolean {
    return this.phase !== "idle";
  }

  /** Whether the agent is currently processing a query. */
  get processing(): boolean {
    return this.phase === "active";
  }

  /** Whether the panel is currently visible on screen. */
  get visible(): boolean {
    return this._visible;
  }

  get terminalBuffer(): TerminalBuffer | null {
    return this.buffer;
  }

  /** Open a fresh panel with a new conversation. */
  open(): void {
    if (this.phase !== "idle") return;
    this.ensureBuffer();

    this.phase = "input";
    this.editor.clear();
    this.contentLines = [];
    this.currentPartialLine = "";
    this.scrollOffset = 0;
    this.userScrolled = false;
    this.title = "";
    this.footer = "";
    this.prevFrame = [];

    this.enterScreen();
  }

  /** Hide the panel without destroying conversation state. */
  hide(): void {
    if (!this._visible) return;
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    this._visible = false;
    this.prevFrame = [];

    if (this.phase === "active" && this.buffer) {
      // Agent still working — enter passthrough mode.
      // Keep alt screen + stdout held. Render TerminalBuffer directly
      // so the background program's screen stays correct without
      // handing rendering control back to ncurses.
      this._passthrough = true;
      this.ptyBuffer = "";
      this.startPassthrough();
    } else {
      // Agent idle or done — full teardown, hand back control.
      this.teardownScreen();
    }

    this.handlers.call(`${this.prefix}:dismiss`);
  }

  /** Show the panel again after hide(), preserving conversation. */
  show(): void {
    if (this._visible || this.phase === "idle") return;

    if (this._passthrough) {
      // Resume from passthrough — alt screen + stdout hold already active.
      this.stopPassthrough();
      this._passthrough = false;
      this._visible = true;
      this.prevFrame = [];
      this.render();
    } else {
      // Cold show — need full screen setup.
      this.prevFrame = [];
      this.enterScreen();
    }
    this.handlers.call(`${this.prefix}:show`);
  }

  /** Fully destroy the panel, resetting all state. */
  dismiss(): void {
    if (this.phase === "idle") return;
    if (this.autoDismissTimer) { clearTimeout(this.autoDismissTimer); this.autoDismissTimer = null; }

    if (this._passthrough) {
      this.stopPassthrough();
      this._passthrough = false;
      this.teardownScreen();
    } else if (this._visible) {
      this._visible = false;
      if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
      this.prevFrame = [];
      this.teardownScreen();
    }

    this.phase = "idle";
    this.editor.clear();
    this.contentLines = [];
    this.currentPartialLine = "";
    this.scrollOffset = 0;
    this.title = "";
    this.footer = "";
  }

  /** Common screen enter logic shared by open() and show(). */
  private enterScreen(): void {
    this._visible = true;
    this.ptyBuffer = "";
    this.bus.emit("shell:stdout-hold", {});

    this.usedAltScreen = !(this.buffer?.altScreen);
    if (this.usedAltScreen) {
      process.stdout.write("\x1b[?1049h");
    }

    this.resizeHandler = () => { this.prevFrame = []; this.render(); };
    process.stdout.on("resize", this.resizeHandler);

    this.render();
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
    if (this._passthrough) {
      // Agent finished while hidden — session over, hand back control.
      this.dismiss();
      return;
    }
    if (this.config.autoDismissMs > 0) {
      // Legacy behavior: enter done state, auto-dismiss after delay
      this.phase = "done";
      this.render();
      this.autoDismissTimer = setTimeout(() => {
        if (this.phase === "done") this.dismiss();
      }, this.config.autoDismissMs);
    } else {
      // Auto-prompt: transition to input for follow-up conversation
      this.phase = "input";
      this.editor.clear();
      this.render();
    }
  }

  scrollUp(lines = 3): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    this.userScrolled = true;
    this.render();
  }

  scrollDown(lines = 3): void {
    this.scrollOffset += lines;
    this.userScrolled = true;
    this.render();
  }

  getInput(): string {
    return this.editor.text;
  }

  requestRender(): void {
    this.scheduleRender();
  }

  // ── Input handling ──────────────────────────────────────────

  private handleIntercept(payload: { data: string; consumed: boolean }): { data: string; consumed: boolean } {
    const consumed = { ...payload, consumed: true };
    const { data } = payload;

    // Toggle visibility when trigger is pressed and panel is hidden but active
    if (this.isTrigger(data) && this.phase !== "idle" && !this._visible) {
      this.show();
      return consumed;
    }

    // When not visible, only intercept the trigger key
    if (!this._visible && this.phase !== "idle") {
      return payload;
    }

    switch (this.phase) {
      case "done":
        this.dismiss();
        return consumed;

      case "input":
        this.handleInputKey(data);
        return consumed;

      case "active":
        if (data === "\x03") {
          this.bus.emit("agent:cancel-request", {});
        } else if (data === "\x1b" || this.isTrigger(data)) {
          this.hide();
        } else if (this.handleScroll(data)) {
          // scroll handled
        } else {
          this.handlers.call(`${this.prefix}:input`, data);
        }
        return consumed;

      default: // idle
        if (this.isTrigger(data)) {
          this.open();
          return consumed;
        }
        return payload;
    }
  }

  /** Handle scroll input. Returns true if consumed. */
  private handleScroll(data: string): boolean {
    // Arrow up / mouse wheel up
    if (data === "\x1b[A" || data === "\x1bOA") { this.scrollUp(1); return true; }
    // Arrow down / mouse wheel down
    if (data === "\x1b[B" || data === "\x1bOB") { this.scrollDown(1); return true; }
    // Page up (CSI 5~)
    if (data === "\x1b[5~") { this.scrollUp(this.computeGeometry().contentH - 1); return true; }
    // Page down (CSI 6~)
    if (data === "\x1b[6~") { this.scrollDown(this.computeGeometry().contentH - 1); return true; }
    // Mouse wheel: CSI M followed by button byte (64 = wheel up, 65 = wheel down)
    if (data.length >= 6 && data.startsWith("\x1b[M")) {
      const button = data.charCodeAt(3);
      if (button === 96) { this.scrollUp(3); return true; }   // wheel up
      if (button === 97) { this.scrollDown(3); return true; }  // wheel down
    }
    // SGR mouse: CSI < 64;x;yM (wheel up) / CSI < 65;x;yM (wheel down)
    const sgr = data.match(/^\x1b\[<(64|65);\d+;\d+M$/);
    if (sgr) {
      if (sgr[1] === "64") { this.scrollUp(3); return true; }
      if (sgr[1] === "65") { this.scrollDown(3); return true; }
    }
    return false;
  }

  private handleInputKey(data: string): void {
    // Check full data string against trigger sequences (may be multi-byte)
    if (this.isTrigger(data)) { this.hide(); return; }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b" && data[i + 1] == null) { this.hide(); return; }
      if (ch.charCodeAt(0) === 0x03) { this.hide(); return; }
    }

    // Page Up/Down and mouse wheel scroll even in input phase
    if (this.handleScroll(data)) return;

    const actions = this.editor.feed(data);
    for (const action of actions) {
      switch (action.action) {
        case "submit": {
          const query = this.editor.text.trim();
          if (!query) { this.hide(); return; }
          this.editor.pushHistory(query);
          this.phase = "active";
          this.editor.clear();
          this.handlers.call(`${this.prefix}:submit`, query);
          return;
        }
        case "cancel":
          this.hide();
          return;
        case "arrow-up": {
          const hist = this.editor.historyBack();
          if (hist) this.render();
          break;
        }
        case "arrow-down": {
          const hist = this.editor.historyForward();
          if (hist) this.render();
          break;
        }
        case "changed":
        case "tab":
        case "shift+tab":
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
      inputBuffer: this.editor.displayText,
      inputCursor: this.editor.displayCursor,
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
    if (this.phase === "idle" || !this._visible) return;

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

  /** Full screen teardown: exit alt screen, release stdout, force redraw. */
  private teardownScreen(): void {
    if (this.resizeHandler) {
      process.stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    this.suppressNextRedraw = true;

    // Re-check alt screen state: the program we overlaid may have exited
    // (e.g. agent quit vim via terminal_keys) while the panel was active.
    const stillInAltScreen = !this.usedAltScreen && !!this.buffer?.altScreen;
    const programExited = !this.usedAltScreen && !stillInAltScreen;

    if (this.usedAltScreen) {
      process.stdout.write("\x1b[?1049l");
    }

    // Replay PTY output that arrived while the overlay was active.
    // Without this, commands run by the agent (e.g. user_shell ls)
    // would vanish — the alt screen exit restores the saved screen
    // from before the overlay opened, losing any shell output produced
    // during the session.
    if (this.ptyBuffer) {
      process.stdout.write(this.ptyBuffer);
    }
    this.ptyBuffer = "";
    this.bus.emit("shell:stdout-release", {});

    if (stillInAltScreen || programExited) {
      // Either a TUI app is still running and needs SIGWINCH to repaint,
      // or the overlaid program exited (e.g. agent quit vim) and we
      // discarded its stale buffer — SIGWINCH makes the shell redraw
      // its prompt cleanly.
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      this.bus.emit("shell:pty-resize", { cols, rows: rows - 1 });
      setTimeout(() => {
        this.bus.emit("shell:pty-resize", { cols, rows });
      }, 50);
    }
  }

  // ── Passthrough rendering ─────────────────────────────────

  /** Start rendering TerminalBuffer directly (no overlay box). */
  private startPassthrough(): void {
    this.prevSerialized = "";
    this.renderPassthrough();
    this.passthroughTimer = setInterval(() => this.renderPassthrough(), 50);
  }

  private stopPassthrough(): void {
    if (this.passthroughTimer) {
      clearInterval(this.passthroughTimer);
      this.passthroughTimer = null;
    }
    this.prevSerialized = "";
  }

  /** Render the TerminalBuffer's screen content directly (no overlay). */
  private renderPassthrough(): void {
    if (!this.buffer) return;
    this.buffer.flush();
    const serialized = this.buffer.serialize();
    if (serialized && serialized !== this.prevSerialized) {
      this.prevSerialized = serialized;
      process.stdout.write(`${SYNC_START}\x1b[H${serialized}${SYNC_END}`);
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
