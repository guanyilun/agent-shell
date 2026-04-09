export interface CommandRecord {
  command: string;
  output: string;
}

export interface ShellContext {
  cwd: string;
  history: CommandRecord[];
}

export interface AgentShellConfig {
  agentCommand: string;
  agentArgs: string[];
  shell: string;
  model?: string; // Model name extracted from agent args
}

export type ConversationEntry =
  | { type: "shell_command"; command: string; output: string; cwd: string }
  | { type: "agent_query"; query: string }
  | { type: "agent_response"; summary: string };

export interface TerminalSession {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  resolve?: (value: void) => void;
}
