import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { executeCommand, killSession, type ExecutorSession } from "./executor.js";
import { computeDiff } from "./utils/diff.js";
import { FileWatcher } from "./utils/file-watcher.js";
import * as path from "node:path";
import { stripAnsi } from "./utils/ansi.js";
import type { EventBus, ShellEvents } from "./event-bus.js";
import type { ContextManager } from "./context-manager.js";
import type { AgentShellConfig } from "./types.js";

export class AcpClient {
  private agentProcess: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private bus: EventBus;
  private contextManager: ContextManager;
  private config: AgentShellConfig;
  private promptInProgress = false;
  private currentResponseText = "";
  private lastResponseText = "";
  private terminalSessions = new Map<string, ExecutorSession>();
  private terminalDonePromises = new Map<string, Promise<void>>();
  private terminalCounter = 0;
  private fileWatcher: FileWatcher;
  private pendingToolCalls = new Map<string, {
    title: string;
    deferredPayload?: ShellEvents["agent:tool-started"];
  }>();
  private autoCancelled = false;
  private pendingToolCounter = 0;
  private agentInfo: { name: string; version: string } | null = null;
  private modes: { id: string; name: string }[] = [];
  private currentModeId: string | null = null;

  constructor(opts: {
    bus: EventBus;
    contextManager: ContextManager;
    config: AgentShellConfig;
  }) {
    this.bus = opts.bus;
    this.contextManager = opts.contextManager;
    this.config = opts.config;
    this.fileWatcher = new FileWatcher(process.cwd());
  }

  async start(): Promise<void> {
    this.log(`Starting agent: ${this.config.agentCommand} ${this.config.agentArgs.join(" ")}`);

    // Spawn the agent subprocess with the user's full shell environment
    // (includes vars from .zshrc/.bashrc that process.env may not have).
    // Merge in any runtime env vars set by extensions (e.g. AGENT_SH_SOCKET)
    // that weren't present when shellEnv was captured at startup.
    const baseEnv = this.config.shellEnv ?? process.env;
    const agentEnv: Record<string, string> = { ...baseEnv } as Record<string, string>;
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !(k in agentEnv)) {
        agentEnv[k] = v;
      }
    }
    this.agentProcess = spawn(this.config.agentCommand, this.config.agentArgs, {
      stdio: ["pipe", "pipe", process.env.DEBUG ? "inherit" : "ignore"],
      env: agentEnv as NodeJS.ProcessEnv,
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

    this.log("Agent process spawned");

    this.agentProcess.on("exit", (code) => {
      this.bus.emit("agent:error", { message: `Agent process exited with code ${code}` });
      this.connection = null;
      this.sessionId = null;
    });

    if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
      throw new Error("Failed to get agent process stdio");
    }

    // Create ACP stream from the agent's stdio
    const output = Writable.toWeb(this.agentProcess.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(this.agentProcess.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    this.log("Creating ACP connection");

    // Create the client-side connection, providing our Client handler
    this.connection = new acp.ClientSideConnection(
      (_agent) => this.createClientHandler(),
      stream,
    );

    // Initialize the connection with timeout
    this.log("Sending initialize request");
    const initTimeoutMs = 30000; // 30 seconds
    const initResponse = await Promise.race([
      this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "agent-sh", version: "0.1.0" },
        clientCapabilities: {
          terminal: true,
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Initialize timeout after ${initTimeoutMs}ms`)), initTimeoutMs)
      ),
    ]);

    this.log("Initialize successful");

    // Store agent info for display
    if (initResponse.agentInfo) {
      this.agentInfo = {
        name: initResponse.agentInfo.name || this.config.agentCommand,
        version: initResponse.agentInfo.version || "unknown"
      };
      this.log(`Agent info: ${this.agentInfo.name} v${this.agentInfo.version}`);
    }

    // Create a session — let extensions add MCP servers via pipe
    const cwd = this.contextManager.getCwd();
    this.log(`Creating new session with cwd: ${cwd}`);
    const sessionConfig = this.bus.emitPipe("session:configure", {
      cwd,
      mcpServers: [],
    });
    const sessionTimeoutMs = 30000; // 30 seconds
    const sessionResponse = await Promise.race([
      this.connection.newSession({
        cwd: sessionConfig.cwd,
        mcpServers: sessionConfig.mcpServers as acp.McpServer[],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`newSession timeout after ${sessionTimeoutMs}ms`)), sessionTimeoutMs)
      ),
    ]);

    this.sessionId = sessionResponse.sessionId;
    this.log(`Session created: ${this.sessionId}`);

    // Parse session modes (thinking level, etc.)
    this.updateModes(sessionResponse);

    // Listen for mode cycle requests from input handler
    this.bus.on("config:cycle", () => this.cycleMode());
  }

  /**
   * Send a user query to the agent.
   */
  private firstPromptSent = false;

  private static readonly SESSION_ORIENTATION = [
    "You are running inside agent-sh, a terminal wrapper that gives the user two interaction modes:",
    "",
    "QUERY mode (triggered by '?'): The user is asking questions or requesting tasks.",
    "Use your internal tools (bash, file operations, etc.) to accomplish tasks.",
    "Do NOT use user_shell in this mode.",
    "",
    "EXECUTE mode (triggered by '>'): The user wants a command run in their live shell session.",
    "You may use shell_recall to understand previous context and your own tools to investigate,",
    "but the final action must be sending the command via user_shell,",
    "which executes in the user's actual shell (with their aliases, env vars, and cwd).",
    "Do not explain or ask for confirmation — just run it.",
    "",
    "Each prompt includes a per-query mode instruction — follow it.",
    "",
    "Available tools:",
    "- user_shell: Runs commands in the user's live shell session (their PTY). Use in EXECUTE mode.",
    "- shell_recall: Retrieves recent shell command history and output from the user's session.",
    "  Use this to understand what the user has been doing before answering questions.",
    "- Your standard tools (bash, file read/write, etc.): Use in AGENT mode.",
  ].join("\n");

  async sendPrompt(query: string, opts?: { modeInstruction?: string; modeLabel?: string }): Promise<void> {
    if (!this.connection || !this.sessionId) {
      this.bus.emit("agent:error", { message: "Not connected to agent" });
      return;
    }

    this.promptInProgress = true;
    this.bus.emit("agent:processing-start", {});
    await this.fileWatcher.snapshot();

    this.currentResponseText = "";
    this.autoCancelled = false;
    let cancelled = false;

    // Emit agent query event (TUI renders echo+spinner, ContextManager records it)
    this.bus.emit("agent:query", { query, modeLabel: opts?.modeLabel });

    // Build structured context from ContextManager
    const contextBlock = this.contextManager.getContext();

    try {
      this.log("sending prompt...");
      const promptContent: { type: "text"; text: string }[] = [];
      // Send session orientation on first prompt
      if (!this.firstPromptSent) {
        promptContent.push({ type: "text", text: AcpClient.SESSION_ORIENTATION });
        this.firstPromptSent = true;
      }
      if (opts?.modeInstruction) {
        promptContent.push({ type: "text", text: opts.modeInstruction });
      }
      promptContent.push({ type: "text", text: contextBlock + "\n" + query });

      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: promptContent,
      });

      this.log(`prompt resolved: stopReason=${response.stopReason}`);

      if (response.stopReason === "cancelled") {
        cancelled = true;
        if (!this.autoCancelled) {
          this.bus.emit("agent:cancelled", {});
        }
      }
    } catch (err) {
      this.log(`prompt error: ${err}`);
      this.bus.emit("agent:error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.log("restoring shell mode");
      if (!cancelled) {
        this.bus.emitTransform("agent:response-done", {
          response: this.currentResponseText,
        });
      }
      this.lastResponseText = this.currentResponseText;

      // Show diff previews for files the agent modified via its own tools
      // (modifications via fs/writeTextFile are already handled inline)
      if (this.promptInProgress) {
        await this.showPendingFileChanges();
      }

      this.bus.emit("agent:processing-done", {});
      this.promptInProgress = false;
    }
  }

  /**
   * Silently cancel the prompt after a shell tool completes.
   * Unlike user-initiated cancel(), this doesn't show "(cancelled)" —
   * the tool already ran, we just skip the unnecessary LLM follow-up.
   */
  private autoCancel(): void {
    if (!this.connection || !this.sessionId || !this.promptInProgress) return;
    this.log("auto-cancel: shell tool completed, skipping LLM follow-up");
    this.autoCancelled = true;
    this.connection.cancel({ sessionId: this.sessionId }).catch(() => {});
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
    if (this.promptInProgress) {
      this.bus.emit("agent:cancelled", {});
    }
    this.bus.emit("agent:processing-done", {});
    this.promptInProgress = false;
  }

  /**
   * Start a new ACP session, clearing agent-side conversation history.
   */
  async resetSession(): Promise<void> {
    if (!this.connection) return;
    const sessionConfig = this.bus.emitPipe("session:configure", {
      cwd: this.contextManager.getCwd(),
      mcpServers: [],
    });
    const sessionResponse = await this.connection.newSession({
      cwd: sessionConfig.cwd,
      mcpServers: sessionConfig.mcpServers as acp.McpServer[],
    });
    this.sessionId = sessionResponse.sessionId;
    this.lastResponseText = "";
    this.currentResponseText = "";
    this.firstPromptSent = false;
    this.updateModes(sessionResponse);
  }

  /**
   * Get the text of the last agent response (for /copy).
   */
  getLastResponseText(): string {
    return this.lastResponseText;
  }

  /**
   * Get agent information for display.
   */
  getAgentInfo(): { name: string; version: string } | null {
    return this.agentInfo;
  }

  getModel(): string | undefined {
    return this.config.model;
  }

  /**
   * Get the current mode (e.g. thinking level).
   */
  getCurrentMode(): { id: string; name: string } | null {
    if (!this.currentModeId) return null;
    return this.modes.find((m) => m.id === this.currentModeId) ?? null;
  }

  /**
   * Check if agent is connected.
   */
  isConnected(): boolean {
    // Consider connected if we have a connection and agent info
    // Session ID may not be set yet if we're still initializing
    return this.connection !== null && this.agentInfo !== null;
  }

  /**
   * Parse modes from a session response and notify listeners.
   */
  private updateModes(response: any): void {
    const modes = response.modes;
    if (!modes) return;
    if (modes.availableModes) {
      this.modes = modes.availableModes.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
      }));
    }
    if (modes.currentModeId) {
      this.currentModeId = modes.currentModeId;
    }
    this.bus.emit("config:changed", {});
  }

  /**
   * Cycle to the next session mode.
   */
  private async cycleMode(): Promise<void> {
    if (!this.connection || !this.sessionId || this.modes.length === 0) return;

    const currentIdx = this.modes.findIndex((m) => m.id === this.currentModeId);
    const nextIdx = (currentIdx + 1) % this.modes.length;
    const nextMode = this.modes[nextIdx]!;

    try {
      await this.connection.setSessionMode({
        sessionId: this.sessionId,
        modeId: nextMode.id,
      });
      this.currentModeId = nextMode.id;
      this.bus.emit("config:changed", {});
    } catch (err) {
      this.log(`Failed to set mode: ${err}`);
    }
  }

  private log(msg: string): void {
    if (process.env.DEBUG) {
      process.stderr.write(`[agent-sh] ${msg}\n`);
    }
  }


  /**
   * Create the Client handler that responds to agent requests.
   */
  private createClientHandler(): acp.Client {
    return {
      // Required: handle session update notifications (streaming)
      // Errors must not propagate — the ACP SDK returns them as error
      // responses to the agent, which can stall the stream.
      sessionUpdate: async (params) => {
        try {
          this.handleSessionUpdate(params);
        } catch (err) {
          this.log(`Error in sessionUpdate handler: ${err instanceof Error ? err.stack : err}`);
        }
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
        const content = update.content;
        if (content.type === "text") {
          this.currentResponseText += content.text;
          this.bus.emitTransform("agent:response-chunk", { text: content.text });
        }
        break;
      }

      case "agent_thought_chunk": {
        const thought = update.content;
        if (thought.type === "text" && thought.text) {
          this.bus.emitTransform("agent:thinking-chunk", { text: thought.text });
        }
        break;
      }

      case "tool_call": {
        const toolId = update.toolCallId || `tool-${this.pendingToolCounter++}`;
        const payload: ShellEvents["agent:tool-started"] = {
          title: update.title,
          toolCallId: toolId,
          kind: update.kind ?? undefined,
          locations: update.locations?.map((l) => ({ path: l.path, line: l.line })),
          rawInput: update.rawInput,
        };
        const defer = this.pendingToolCalls.size > 0;
        this.pendingToolCalls.set(toolId, {
          title: update.title ?? "",
          deferredPayload: defer ? payload : undefined,
        });
        if (!defer) {
          this.bus.emit("agent:tool-started", payload);
        }
        break;
      }

      case "tool_call_update": {
        const toolId = update.toolCallId;
        const toolInfo = toolId ? this.pendingToolCalls.get(toolId) : undefined;
        const toolTitle = toolInfo?.title;

        if (update.status === "completed" || update.status === "failed") {
          // Emit deferred tool-started before output (parallel tools)
          if (toolInfo?.deferredPayload) {
            this.bus.emit("agent:tool-started", toolInfo.deferredPayload);
            toolInfo.deferredPayload = undefined;
          }

          // Show content only on final status. Skip tools whose output the
          // user already sees (user_shell → PTY) or is agent-only (shell_recall).
          const skipOutput = toolTitle === "user_shell" || toolTitle === "shell_recall";
          if (!skipOutput && update.content && Array.isArray(update.content)) {
            for (const block of update.content) {
              if (block.type === "content" && block.content?.type === "text" && block.content.text) {
                this.bus.emitTransform("agent:tool-output-chunk", { chunk: block.content.text });
              }
            }
          }
          const exitCode = update.status === "completed" ? 0 : 1;
          if (toolId && this.pendingToolCalls.has(toolId)) {
            this.pendingToolCalls.delete(toolId);
            this.bus.emit("agent:tool-completed", {
              toolCallId: toolId,
              exitCode,
              rawOutput: update.rawOutput,
            });
          } else if (!toolId) {
            this.bus.emit("agent:tool-completed", { exitCode, rawOutput: update.rawOutput });
          }

          // Auto-cancel after shell tools complete — the command already
          // ran in the user's PTY, no need for a second LLM round trip.
          // The result is captured in shell context / shell_recall.
          if (toolTitle === "user_shell" && update.status === "completed") {
            this.autoCancel();
          }
        }
        break;
      }

      case "current_mode_update": {
        const modeId = (update as any).currentModeId;
        if (modeId) {
          this.currentModeId = modeId;
          this.bus.emit("config:changed", {});
        }
        break;
      }

      default:
        break;
    }
  }

  // ── Permission handler ─────────────────────────────────────────

  private async handleRequestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const title = params.toolCall.title ?? "Unknown action";

    const result = await this.bus.emitPipeAsync("permission:request", {
      kind: "tool-call",
      title,
      metadata: {
        options: params.options.map((o) => ({
          optionId: o.optionId,
          kind: o.kind,
        })),
      },
      decision: { // default: auto-approve (yolo mode); extensions can override to gate
        outcome: "selected",
        optionId: (params.options.find((o) => o.kind === "allow_once") ?? params.options[0])?.optionId,
      },
    });

    return { outcome: result.decision as acp.RequestPermissionOutcome };
  }

  // ── Terminal handlers (isolated execution via child_process) ────

  private async handleCreateTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const fullCommand = params.args?.length
      ? `${params.command} ${params.args.join(" ")}`
      : params.command;

    const cwd = params.cwd ?? this.contextManager.getCwd();

    // Let extensions intercept before spawning a real process
    const intercept = this.bus.emitPipe("agent:terminal-intercept", {
      command: fullCommand,
      cwd,
      intercepted: false,
      output: "",
    });
    if (intercept.intercepted) {
      const id = `t${++this.terminalCounter}`;
      const session: ExecutorSession = {
        id,
        command: fullCommand,
        output: intercept.output,
        exitCode: 0,
        done: true,
        truncated: false,
        process: null,
      };
      this.terminalSessions.set(id, session);
      this.terminalDonePromises.set(id, Promise.resolve());
      return { terminalId: id };
    }

    this.bus.emit("agent:tool-call", {
      tool: fullCommand,
      args: { command: params.command, args: params.args, cwd },
    });

    const id = `t${++this.terminalCounter}`;

    const { session, done } = executeCommand({
      command: fullCommand,
      cwd,
      env: this.config.shellEnv,
      timeout: 60_000,
      maxOutputBytes: 256 * 1024,
      onOutput: (chunk) => {
        // Stream output into the box in real-time (strip ANSI for display)
        this.bus.emit("agent:tool-output-chunk", { chunk: stripAnsi(chunk) });
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

    this.bus.emit("agent:tool-output", {
      tool: session.command ?? "",
      output: session.output,
      exitCode: session.exitCode,
    });

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

    // Extensions can gate this — default is auto-approve (yolo mode)
    const result = await this.bus.emitPipeAsync("permission:request", {
      kind: "file-write",
      title: params.path,
      metadata: { path: params.path, diff, content: params.content },
      decision: { approved: true },
    });

    if (!(result.decision as { approved: boolean }).approved) {
      throw new Error(`User rejected modification: ${params.path}`);
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
    const changes = await this.fileWatcher.detectChanges();
    if (changes.length === 0) return;

    for (const change of changes) {
      const diff = computeDiff(change.before, change.after);
      if (diff.isIdentical) continue;

      const result = await this.bus.emitPipeAsync("permission:request", {
        kind: "file-write",
        title: change.relPath,
        metadata: { path: change.relPath, diff, content: change.after },
        decision: { approved: true },
      });

      if ((result.decision as { approved: boolean }).approved) {
        this.fileWatcher.approve(change.path, change.after);
      } else {
        await this.fileWatcher.revert(change.path);
      }
    }
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

