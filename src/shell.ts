import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import type { EventBus } from "./event-bus.js";
import { InputHandler, type InputContext } from "./input-handler.js";
import { OutputParser } from "./output-parser.js";

export class Shell implements InputContext {
  private ptyProcess: pty.IPty;
  private bus: EventBus;
  private inputHandler: InputHandler;
  private outputParser: OutputParser;
  private paused = false;
  private agentActive = false;
  private tmpDir?: string;

  constructor(opts: {
    bus: EventBus;
    onShowAgentInfo?: () => { info: string; model?: string };
    cols: number;
    rows: number;
    shell: string;
    cwd: string;
  }) {

    // Build environment — filter out undefined values (node-pty's native
    // posix_spawnp fails if any env value is undefined)
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.AGENT_SH = "1";

    // Spawn the user's shell with their full config (aliases, plugins, PATH,
    // completions, etc.). The core injects three invisible OSC hooks:
    //   - OSC 7: cwd tracking (required by OutputParser)
    //   - OSC 9999: prompt start marker (command boundary detection)
    //   - OSC 9998: prompt end marker (bracketed prompt capture)
    // Prompt theming is left entirely to the user's shell config.
    const shellName = path.basename(opts.shell);
    const isZsh = shellName.includes("zsh");
    const isBash = shellName.includes("bash");
    if (!isZsh && !isBash) {
      console.warn(
        `Warning: agent-sh only supports zsh and bash. ` +
        `"${opts.shell}" may not work correctly — falling back to /bin/bash.`
      );
    }
    const shellBin = (isZsh || isBash) ? opts.shell : "/bin/bash";
    let shellArgs: string[];

    const osc7Cmd = 'printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"';
    const promptMarker = 'printf "\\e]9999;PROMPT\\a"';

    if (isZsh) {
      // For zsh: use ZDOTDIR to source user's real config, then append
      // our hooks via precmd_functions (additive — doesn't clobber p10k/omz).
      this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sh-"));
      const userZdotdir = env.ZDOTDIR || env.HOME || os.homedir();
      fs.writeFileSync(path.join(this.tmpDir, ".zshrc"), [
        `ZDOTDIR="${userZdotdir}"`,
        `[ -f "${userZdotdir}/.zshrc" ] && source "${userZdotdir}/.zshrc"`,
        "",
        "# agent-sh hooks (invisible OSC sequences for cwd + prompt detection)",
        "__agent_sh_precmd() {",
        `  ${osc7Cmd}`,
        `  ${promptMarker}`,
        "}",
        "precmd_functions+=(__agent_sh_precmd)",
        "",
        "# End-of-prompt marker via zle-line-init (fires after prompt is rendered)",
        "# Chain onto existing widget (p10k uses zle-line-init) rather than clobbering",
        'if (( ${+widgets[zle-line-init]} )); then',
        "  zle -A zle-line-init __agent_sh_orig_line_init",
        "  __agent_sh_line_init() {",
        "    zle __agent_sh_orig_line_init",
        '    printf "\\e]9998;READY\\a"',
        "  }",
        "else",
        "  __agent_sh_line_init() {",
        '    printf "\\e]9998;READY\\a"',
        "  }",
        "fi",
        "zle -N zle-line-init __agent_sh_line_init",
      ].join("\n") + "\n");
      env.ZDOTDIR = this.tmpDir;
      shellArgs = ["--no-globalrcs"];
    } else {
      // For bash: use --rcfile to source our wrapper, which sources the user's
      // real bashrc then appends our hooks. No HOME override needed.
      this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sh-"));
      const userHome = env.HOME || os.homedir();
      fs.writeFileSync(path.join(this.tmpDir, ".bashrc"), [
        `[ -f "${userHome}/.bashrc" ] && source "${userHome}/.bashrc"`,
        "",
        "# agent-sh hooks (invisible OSC sequences for cwd + prompt detection)",
        `PROMPT_COMMAND="\${PROMPT_COMMAND:+\$PROMPT_COMMAND;}${osc7Cmd}; ${promptMarker}"`,
        "",
        "# End-of-prompt marker: append to PS1 (\\[...\\] marks it zero-width)",
        'case "$PS1" in *9998*) ;; *) PS1="${PS1}\\[\\e]9998;READY\\a\\]";; esac',
      ].join("\n") + "\n");
      shellArgs = ["--rcfile", path.join(this.tmpDir, ".bashrc")];
    }

    this.ptyProcess = pty.spawn(shellBin, shellArgs, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    this.bus = opts.bus;
    this.outputParser = new OutputParser(opts.bus, opts.cwd);

    // Ensure temp dir cleanup on abnormal exit (SIGKILL won't fire this,
    // but it covers uncaught exceptions and normal process.exit paths)
    if (this.tmpDir) {
      const dir = this.tmpDir;
      process.on("exit", () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      });
    }

    this.inputHandler = new InputHandler({
      ctx: this,
      bus: opts.bus,
      onShowAgentInfo: opts.onShowAgentInfo ?? (() => ({ info: "" })),
    });

    this.setupOutput();
    this.setupInput();
    this.setupAgentLifecycle();
  }

  // ── InputContext implementation (delegates to OutputParser) ──

  isForegroundBusy(): boolean {
    return this.outputParser.isForegroundBusy();
  }

  getCwd(): string {
    return this.outputParser.getCwd();
  }

  isAgentActive(): boolean {
    return this.agentActive;
  }

  writeToPty(data: string): void {
    this.ptyProcess.write(data);
  }

  /**
   * Lightweight redraw: replay just the last line of the shell's prompt
   * (e.g. p10k's "❯ "). This works because agent input mode only overwrites
   * the final prompt line — the path bar above is still intact. The last
   * line is linear text (colors + chars + clear-to-end), no cursor positioning.
   */
  redrawPrompt(): void {
    const result = this.bus.emitPipe("shell:redraw-prompt", {
      cwd: this.outputParser.getCwd(),
      handled: false,
    });
    if (!result.handled) {
      const lastLine = this.outputParser.getLastPromptLine();
      if (lastLine) {
        process.stdout.write("\r" + lastLine);
      } else {
        // Fallback: send \n for a fresh prompt cycle
        this.ptyProcess.write("\n");
      }
    }
  }

  /**
   * Heavy redraw: send \n to PTY to trigger a full precmd → prompt cycle.
   * Use this after agent responses where stdout has moved far from where
   * zle expects the cursor. The blank line is acceptable as a separator.
   */
  freshPrompt(): void {
    this.ptyProcess.write("\n");
  }

  onCommandEntered(command: string, cwd: string): void {
    this.outputParser.onCommandEntered(command, cwd);
  }

  // ── PTY I/O wiring ─────────────────────────────────────────

  private setupOutput(): void {
    this.ptyProcess.onData((data: string) => {
      this.outputParser.processData(data);

      if (!this.paused) {
        process.stdout.write(data);
      }
    });
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const str = data.toString("utf-8");
      this.inputHandler.handleInput(str);
    });
  }

  /**
   * React to agent lifecycle events — Shell manages its own state
   * rather than being driven by AcpClient. This means AcpClient has
   * zero frontend knowledge; any frontend can subscribe to the same events.
   */
  private setupAgentLifecycle(): void {
    this.bus.on("agent:processing-start", () => {
      this.agentActive = true;
      this.paused = true;
    });

    this.bus.on("agent:processing-done", () => {
      this.paused = false;
      this.agentActive = false;
      this.freshPrompt();
    });

    // Permission prompts need stdout unpaused so the interactive UI renders,
    // then re-paused after the decision.
    this.bus.on("permission:request", () => {
      this.paused = false;
    });
    this.bus.onPipeAsync("permission:request", async (payload) => {
      this.paused = true;
      return payload;
    });
  }

  // ── Public API (used by index.ts) ──

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void {
    this.ptyProcess.onExit(callback);
  }

  kill(): void {
    this.ptyProcess.kill();
    if (this.tmpDir) {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    }
  }
}
