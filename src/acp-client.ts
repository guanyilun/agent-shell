import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { executeCommand, killSession, type ExecutorSession } from "./executor.js";
import { computeDiff } from "./diff.js";
import { FileWatcher } from "./file-watcher.js";
import * as path from "node:path";
import type { Shell } from "./shell.js";
import type { TUI } from "./tui.js";
import type { AgentShellConfig } from "./types.js";

export class AcpClient {
  private agentProcess: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private shell: Shell;
  private tui: TUI;
  private config: AgentShellConfig;
  private promptInProgress = false;
  private currentResponseText = "";
  private lastResponseText = "";
  private terminalSessions = new Map<string, ExecutorSession>();
  private terminalDonePromises = new Map<string, Promise<void>>();
  private terminalCounter = 0;
  private autoApproveWrites = false;
  private fileWatcher: FileWatcher;

  constructor(shell: Shell, tui: TUI, config: AgentShellConfig) {
    this.shell = shell;
    this.tui = tui;
    this.config = config;
    this.fileWatcher = new FileWatcher(process.cwd());
  }

  async start(): Promise<void> {
    // Spawn the agent subprocess
    // Spawn the agent — wait briefly to catch ENOENT and other spawn errors
    this.agentProcess = spawn(this.config.agentCommand, this.config.agentArgs, {
      stdio: ["pipe", "pipe", process.env.DEBUG ? "inherit" : "ignore"],
    });

    // Catch spawn errors (ENOENT, EACCES, etc.) before proceeding
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(new Error(`Failed to start agent "${this.config.agentCommand}": ${err.message}`));
      };
      this.agentProcess!.on("error", onError);
      // spawn errors fire on next tick — wait for that, then detach the listener
      setTimeout(() => {
        this.agentProcess!.removeListener("error", onError);
        resolve();
      }, 100);
    });

    this.agentProcess.on("exit", (code) => {
      this.tui.showError(`Agent process exited with code ${code}`);
      this.connection = null;
    });

    if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
      throw new Error("Failed to get agent process stdio");
    }

    // Create ACP stream from the agent's stdio
    const output = Writable.toWeb(this.agentProcess.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(this.agentProcess.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    // Create the client-side connection, providing our Client handler
    this.connection = new acp.ClientSideConnection(
      (_agent) => this.createClientHandler(),
      stream,
    );

    // Initialize the connection
    const initResponse = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "agent-shell", version: "0.1.0" },
      clientCapabilities: {
        terminal: true,
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    // Connection info available at initResponse.agentInfo if needed

    // Create a session
    const context = this.shell.getContext();
    const sessionResponse = await this.connection.newSession({
      cwd: context.cwd,
      mcpServers: [],
    });

    this.sessionId = sessionResponse.sessionId;
  }

  /**
   * Send a user query to the agent.
   */
  async sendPrompt(query: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      this.tui.showError("Not connected to agent");
      return;
    }

    this.promptInProgress = true;
    this.shell.setAgentActive(true);
    this.shell.pauseOutput();
    await this.fileWatcher.snapshot();

    // Echo the user's query
    const CYAN = "\x1b[36m";
    const BOLD = "\x1b[1m";
    const RESET = "\x1b[0m";
    const GRAY = "\x1b[90m";
    process.stdout.write(`\n${CYAN}${BOLD}❯ ${RESET}${CYAN}${query}${RESET}\n`);

    this.currentResponseText = "";
    this.tui.startAgentResponse();
    this.tui.startSpinner();

    // Include shell context — cwd + commands executed since last agent interaction
    const context = this.shell.getContext();
    const recentActivity = this.shell.getAndClearRecentActivity();
    let contextBlock = `<shell_context>\n`;
    contextBlock += `cwd: ${context.cwd}\n`;
    if (recentActivity.length > 0) {
      contextBlock += `\nshell_activity_since_last_interaction:\n`;
      for (const entry of recentActivity) {
        contextBlock += `$ ${entry.command}\n`;
        if (entry.output) {
          contextBlock += `${entry.output}\n`;
        }
        contextBlock += `\n`;
      }
    }
    contextBlock += `</shell_context>\n\n`;

    try {
      this.log("sending prompt...");
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [
          {
            type: "text",
            text: contextBlock + query,
          },
        ],
      });

      this.tui.stopSpinner();
      this.log(`prompt resolved: stopReason=${response.stopReason}`);

      if (response.stopReason === "cancelled") {
        this.tui.showInfo("(cancelled)");
      }
    } catch (err) {
      this.tui.stopSpinner();
      this.log(`prompt error: ${err}`);
      this.tui.showError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.log("restoring shell mode");
      this.lastResponseText = this.currentResponseText;
      this.tui.endAgentResponse();

      // Show diff previews for files the agent modified via its own tools
      // (modifications via fs/writeTextFile are already handled inline)
      if (this.promptInProgress) {
        await this.showPendingFileChanges();
      }

      this.shell.resumeOutput();
      this.shell.setAgentActive(false);
      this.shell.printPrompt();
      this.promptInProgress = false;
    }
  }

  /**
   * Cancel the current prompt and force-recover shell mode.
   */
  async cancel(): Promise<void> {
    this.log("cancel requested");
    // Kill all running terminal sessions
    for (const session of this.terminalSessions.values()) {
      if (!session.done) killSession(session);
    }
    if (this.connection && this.sessionId && this.promptInProgress) {
      try {
        await this.connection.cancel({ sessionId: this.sessionId });
      } catch {
        // Cancellation is best-effort
      }
    }
    // Force-recover shell regardless of prompt state
    this.tui.stopSpinner();
    this.tui.showInfo("(cancelled)");
    this.tui.endAgentResponse();
    this.shell.resumeOutput();
    this.shell.setAgentActive(false);
    this.shell.printPrompt();
    this.promptInProgress = false;
  }

  /**
   * Start a new ACP session, clearing agent-side conversation history.
   */
  async resetSession(): Promise<void> {
    if (!this.connection) return;
    const context = this.shell.getContext();
    const sessionResponse = await this.connection.newSession({
      cwd: context.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionResponse.sessionId;
    this.lastResponseText = "";
    this.currentResponseText = "";
  }

  /**
   * Get the text of the last agent response (for /copy).
   */
  getLastResponseText(): string {
    return this.lastResponseText;
  }

  private log(msg: string): void {
    if (process.env.DEBUG) {
      process.stderr.write(`[agent-shell] ${msg}\n`);
    }
  }

  /**
   * Create the Client handler that responds to agent requests.
   */
  private createClientHandler(): acp.Client {
    return {
      // Required: handle session update notifications (streaming)
      sessionUpdate: async (params) => {
        this.handleSessionUpdate(params);
      },

      // Required: handle permission requests
      requestPermission: async (params) => {
        return this.handleRequestPermission(params);
      },

      // Optional: terminal operations
      createTerminal: async (params) => {
        return this.handleCreateTerminal(params);
      },

      terminalOutput: async (params) => {
        return this.handleTerminalOutput(params);
      },

      waitForTerminalExit: async (params) => {
        return this.handleWaitForTerminalExit(params);
      },

      killTerminal: async (params) => {
        return this.handleKillTerminal(params);
      },

      releaseTerminal: async (params) => {
        return this.handleReleaseTerminal(params);
      },

      // Optional: filesystem operations
      readTextFile: async (params) => {
        return this.handleReadTextFile(params);
      },

      writeTextFile: async (params) => {
        return this.handleWriteTextFile(params);
      },
    };
  }

  // ── Session update handler ─────────────────────────────────────

  private handleSessionUpdate(params: acp.SessionNotification): void {
    // Suppress rendering during initialization / between prompts
    if (!this.promptInProgress) return;

    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        this.tui.stopSpinner();
        const content = update.content;
        if (content.type === "text") {
          this.currentResponseText += content.text;
          this.tui.writeAgentText(content.text);
        }
        break;
      }

      case "agent_thought_chunk": {
        // Hide thinking — don't display to user
        break;
      }

      case "tool_call": {
        this.tui.stopSpinner();
        this.tui.showToolCall(update.title);
        break;
      }

      case "tool_call_update": {
        if (update.title) {
          this.tui.showToolCall(update.title);
        }
        if (update.status === "completed") {
          this.tui.showToolResult(0);
        } else if (update.status === "failed") {
          this.tui.showToolResult(1);
        }
        break;
      }

      default:
        // Ignore other update types for now
        break;
    }
  }

  // ── Permission handler ─────────────────────────────────────────

  private async handleRequestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const title = params.toolCall.title ?? "Unknown action";

    // Find approve/deny options
    const approveOption = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always"
    );

    this.shell.resumeOutput(); // Show the prompt in the terminal
    const decision = await this.tui.promptPermission(title);
    this.shell.pauseOutput();

    if (decision === "approve" || decision === "approve_all") {
      const selectedOption =
        decision === "approve_all"
          ? params.options.find((o) => o.kind === "allow_always") ?? approveOption
          : approveOption;

      if (selectedOption) {
        return {
          outcome: { outcome: "selected", optionId: selectedOption.optionId },
        };
      }
    }

    return { outcome: { outcome: "cancelled" } };
  }

  // ── Terminal handlers (isolated execution via child_process) ────

  private async handleCreateTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const fullCommand = params.args?.length
      ? `${params.command} ${params.args.join(" ")}`
      : params.command;

    const context = this.shell.getContext();
    const cwd = params.cwd ?? context.cwd;

    this.tui.showToolCall(`$ ${fullCommand}`);

    const id = `t${++this.terminalCounter}`;

    const { session, done } = executeCommand({
      command: fullCommand,
      cwd,
      timeout: 60_000,
      maxOutputBytes: 256 * 1024,
      onOutput: (chunk) => {
        // Stream output into the box in real-time (strip ANSI for display)
        this.tui.writeCommandOutput(this.stripAnsi(chunk));
      },
    });

    session.id = id;
    this.terminalSessions.set(id, session);
    this.terminalDonePromises.set(id, done);

    return { terminalId: id };
  }

  private async handleTerminalOutput(
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> {
    const session = this.terminalSessions.get(params.terminalId);
    if (!session) {
      return { output: "", truncated: false };
    }

    return {
      output: session.output,
      truncated: session.truncated,
      ...(session.done && {
        exitStatus: { exitCode: session.exitCode },
      }),
    };
  }

  private async handleWaitForTerminalExit(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const session = this.terminalSessions.get(params.terminalId);
    if (!session) {
      return { exitCode: -1 };
    }

    if (!session.done) {
      const done = this.terminalDonePromises.get(params.terminalId);
      if (done) await done;
    }

    this.tui.flushCommandOutput();
    this.tui.showToolResult(session.exitCode);

    return { exitCode: session.exitCode ?? -1 };
  }

  private async handleKillTerminal(
    params: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse | void> {
    const session = this.terminalSessions.get(params.terminalId);
    if (session && !session.done) {
      killSession(session);
    }
    return {};
  }

  private async handleReleaseTerminal(
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse | void> {
    this.terminalSessions.delete(params.terminalId);
    this.terminalDonePromises.delete(params.terminalId);
    return {};
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[^m]*m/g, "")
      .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "")
      .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")
      .replace(/\r/g, "");
  }

  // ── Filesystem handlers ────────────────────────────────────────

  private async handleReadTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    try {
      let content = await fs.readFile(params.path, "utf-8");

      if (params.line != null || params.limit != null) {
        const lines = content.split("\n");
        const start = (params.line ?? 1) - 1;
        const end = params.limit != null ? start + params.limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }

      return { content };
    } catch (err) {
      throw new Error(
        `Failed to read ${params.path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async handleWriteTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    // Read original content for diff preview
    let original: string | null = null;
    try {
      original = await fs.readFile(params.path, "utf-8");
    } catch {
      // File doesn't exist yet — will show as "new file"
    }

    const diff = computeDiff(original, params.content);

    // Identical content — nothing to do
    if (diff.isIdentical) return {};

    // Show interactive diff preview (unless auto-approved)
    if (!this.autoApproveWrites) {
      this.tui.stopSpinner();
      this.tui.flushCommandOutput();
      this.tui.flushRenderer();
      this.tui.endAgentResponse();

      this.shell.resumeOutput();
      const decision = await this.tui.previewDiff({
        path: params.path,
        diff,
      });
      this.shell.pauseOutput();

      if (decision === "reject") {
        throw new Error(`User rejected modification: ${params.path}`);
      }
      if (decision === "approve_all") {
        this.autoApproveWrites = true;
      }
      // Renderer will be lazily re-created on next agent output
    }

    // Write the file
    try {
      await fs.writeFile(params.path, params.content, "utf-8");
      this.fileWatcher.approve(path.resolve(params.path), params.content);
      return {};
    } catch (err) {
      throw new Error(
        `Failed to write ${params.path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Diff preview for non-ACP file changes ────────────────────

  /**
   * After the agent finishes, check all tracked files for changes
   * made via the agent's own tools (not through fs/writeTextFile)
   * and show interactive diff previews.
   */
  private async showPendingFileChanges(): Promise<void> {
    if (this.autoApproveWrites) return;

    const changes = await this.fileWatcher.detectChanges();
    if (changes.length === 0) return;

    this.shell.resumeOutput();

    for (const change of changes) {
      const diff = computeDiff(change.before, change.after);
      if (diff.isIdentical) continue;

      const decision = await this.tui.previewDiff({
        path: change.relPath,
        diff,
      });

      if (decision === "approve" || decision === "approve_all") {
        this.fileWatcher.approve(change.path, change.after);
      } else {
        await this.fileWatcher.revert(change.path);
      }

      if (decision === "approve_all") {
        this.autoApproveWrites = true;
        // Approve remaining changes automatically
        for (const remaining of changes.slice(changes.indexOf(change) + 1)) {
          this.fileWatcher.approve(remaining.path, remaining.after);
        }
        break;
      }
    }

    this.shell.pauseOutput();
  }

  // ── Cleanup ────────────────────────────────────────────────────

  kill(): void {
    for (const session of this.terminalSessions.values()) {
      if (!session.done) killSession(session);
    }
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill("SIGTERM");
    }
  }
}

