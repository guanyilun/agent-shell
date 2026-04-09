import * as pty from "node-pty";
import type { EventBus } from "./event-bus.js";
import { InputHandler, type InputContext } from "./input-handler.js";
import { OutputParser } from "./output-parser.js";

export class Shell implements InputContext {
  private ptyProcess: pty.IPty;
  private inputHandler: InputHandler;
  private outputParser: OutputParser;
  private paused = false;
  private agentActive = false;
  private onPtyOutput: () => void;

  constructor(opts: {
    bus: EventBus;
    onAgentRequest: (query: string) => void;
    onAgentCancel: () => void;
    onSlashCommand?: (command: string) => void;
    onPtyOutput?: () => void;
    onShowAgentInfo?: () => { info: string; model?: string };
    slashCommandDefs?: { name: string; description: string }[];
    cols: number;
    rows: number;
    shell: string;
    cwd: string;
  }) {
    this.onPtyOutput = opts.onPtyOutput ?? (() => {});

    // Build environment — filter out undefined values (node-pty's native
    // posix_spawnp fails if any env value is undefined)
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.AGENT_SHELL = "1";

    // Use bash with a minimal config to avoid p10k/oh-my-zsh terminal
    // control that conflicts with our status bar. We set up a custom
    // PS1 with the ⚡ indicator and OSC 7 cwd reporting via PROMPT_COMMAND.
    const shellBin = "/bin/bash";
    const osc7Cmd = 'printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"';
    const promptMarker = 'printf "\\e]9999;PROMPT\\a"';
    const ps1 = "\\[\\033[36m\\]⚡\\[\\033[0m\\] \\[\\033[1m\\]\\W\\[\\033[0m\\] \\$ ";

    env.PROMPT_COMMAND = `${osc7Cmd}; ${promptMarker}`;
    env.PS1 = ps1;

    this.ptyProcess = pty.spawn(shellBin, ["--norc", "--noprofile"], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    this.outputParser = new OutputParser(opts.bus, opts.cwd);

    this.inputHandler = new InputHandler({
      ctx: this,
      slashCommandDefs: opts.slashCommandDefs ?? [],
      onAgentRequest: opts.onAgentRequest,
      onAgentCancel: opts.onAgentCancel,
      onSlashCommand: opts.onSlashCommand ?? (() => {}),
      onShowAgentInfo: opts.onShowAgentInfo ?? (() => ({ info: "" })),
    });

    this.setupOutput();
    this.setupInput();
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

  onCommandEntered(command: string, cwd: string): void {
    this.outputParser.onCommandEntered(command, cwd);
  }

  // ── PTY I/O wiring ─────────────────────────────────────────

  private setupOutput(): void {
    this.ptyProcess.onData((data: string) => {
      this.outputParser.processData(data);

      if (!this.paused) {
        process.stdout.write(data);
        this.onPtyOutput();
      }
    });
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const str = data.toString("utf-8");
      this.inputHandler.handleInput(str);
    });
  }

  // ── Public API (used by acp-client, index.ts, commands.ts) ──

  printPrompt(): void {
    this.inputHandler.printPrompt();
  }

  pauseOutput(): void {
    this.paused = true;
  }

  resumeOutput(): void {
    this.paused = false;
  }

  setAgentActive(active: boolean): void {
    this.agentActive = active;
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void {
    this.ptyProcess.onExit(callback);
  }

  kill(): void {
    this.ptyProcess.kill();
  }
}
