# The Built-in Agent: ash

agent-sh is designed to be backend-agnostic. The agent that drives a query — assembling context, calling an LLM, executing tools in a loop — is a replaceable component. Any extension can register a backend via `agent:register-backend` and become the default via the `defaultBackend` setting or the `/backend` slash command. Bridge backends like `claude-code` and `pi` plug external CLI agents into the same shell and TUI surface.

This document describes **ash**, the built-in backend that ships with agent-sh. It is loaded as a built-in extension (`agent-backend`) when an LLM provider is configured. ash resolves providers from settings and CLI flags, creates an `LlmClient`, and calls any OpenAI-compatible API directly. It manages conversation state and executes tools in a loop until the LLM is done.

If you're looking to write your own backend instead of reading how ash works internally, see [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends).

## The Query Flow

Here's what happens when you submit a query:

```
User types "> fix the failing test"
  │
  ├─ 1. Context assembly — gather recent shell commands, output, cwd
  ├─ 2. System prompt (cached per cwd) + dynamic context (rebuilt every LLM call)
  ├─ 3. LLM call — stream response from the API
  ├─ 4. Tool loop — if LLM requested tool calls:
  │     ├─ Execute each tool (with permission check if needed)
  │     ├─ Add results to conversation
  │     └─ Go back to step 3 (LLM sees tool results, decides next action)
  └─ 5. Done — no more tool calls, emit response
```

The key insight: **the agent is a loop, not a single call**. The LLM calls tools, sees results, calls more tools, until it has enough information to respond. A single query might trigger dozens of LLM calls and tool executions.

## Context Assembly

Every query draws on two distinct streams of context:

- **Shell context** — the user's terminal activity (commands + outputs). This is what lets ash understand "fix this" after you ran a failing command. New shell activity since the last turn is injected as a `<shell-events>` delta prepended to your query.
- **Conversation state** — the OpenAI chat messages array (`user`/`assistant`/`tool` messages). This is the LLM's memory of what it already said and did within this session.

The two streams don't overlap: agent tool outputs live only in the conversation, and shell context tracks only user-initiated activity. When either stream grows large, ash has escape hatches rather than silent truncation:

- **Long shell outputs** are spilled to tempfiles (`<tmpdir>/agent-sh-<pid>/<id>.out`) at capture time. The LLM sees a head+tail stub with the path and recovers the full output via plain `read_file`.
- **Older conversation turns** are nucleated into one-line summaries and appended to `~/.agent-sh/history` — a persistent, cross-session archive. The `conversation_recall` tool browses, searches, and expands entries from both the in-session archive and the history file.

Compaction is pluggable: the `conversation:compact` handler is advisable, so extensions can install richer strategies without changing the recall surface. See [Context Management](context-management.md) for the full design.

## System Prompt

The system prompt is assembled once per `cwd` and cached (invalidated when the working directory changes), so the prefix is stable for provider-side prompt caching. It includes:

1. **Identity** — "You are an AI coding assistant running inside agent-sh..."
2. **Tool decision guide** — when to use which built-in tool
3. **Tool usage guidelines** — read before editing, prefer edit over write, use grep/glob to find files, etc.
4. **Project conventions** — `CLAUDE.md`/`AGENT.md` walked from cwd to root (cwd-stable; see next section)
5. **Skills** — discovered project/global skills (cwd-stable)
6. **Extension instructions** — blocks registered by extensions via `registerInstruction()` (e.g. proactive recall guidance)
7. **Available tools** — name + description of every registered tool
8. **Extension-appended content** — extensions can advise `system-prompt:build` to append additional context (instance IDs, memory files, etc.)

**Shell context**, **environment metadata** (date, cwd, token usage), and any other per-iteration signals live in the *dynamic context* — a user-role message injected fresh before every LLM call via the `dynamic-context:build` handler. Each section is wrapped in a named XML tag (`<shell>`, `<environment>`, etc.) so extensions can add their own tagged sections without colliding.

## Project Conventions

The agent automatically loads `CLAUDE.md` or `AGENT.md` files from your working directory hierarchy. These are included in the system prompt on every query, so the agent respects project-specific conventions without being told each time.

The agent scans from your current directory upward to the filesystem root. In each directory it checks for `CLAUDE.md` first, then `AGENT.md` as a fallback (only one per directory). Files are included root-first, so more specific project conventions appear last and take precedence.

```
~/projects/myapp/src/        ← cwd
~/projects/myapp/CLAUDE.md   ← included (project-level)
~/CLAUDE.md                  ← included first (global conventions)
```

Since the system prompt is rebuilt on every query, `cd`-ing to a new project picks up its conventions automatically.

This follows the same convention as Claude Code — if you already have `CLAUDE.md` files, they work out of the box.

## Skills

Skills are reusable instruction sets that the agent can load on demand. They follow the [Agent Skills standard](https://agentskills.io/specification).

### Skill format

A skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: docker-deploy
description: Build and deploy Docker containers to production
---

# Docker Deploy

## Steps

1. Build the image: `docker build -t app .`
2. Tag for registry: `docker tag app registry.example.com/app:latest`
3. Push: `docker push registry.example.com/app:latest`
...
```

The `name` and `description` fields are required. An optional `disable-model-invocation: true` hides the skill from the agent's automatic discovery.

### Discovery

**Global skills** are discovered from `~/.agent-sh/skills/` by default. Add more locations via `skillPaths` in `~/.agent-sh/settings.json`:

```json
{
  "skillPaths": ["~/.agents/skills", "~/.claude/skills"]
}
```

**Project skills** are discovered from `.agents/skills/` in your working directory hierarchy (up to the git root). When you `cd` into a directory with new project skills, the agent is notified with their names.

### How the agent uses skills

Only skill **metadata** (name, description, file path) is included in the system prompt — not the full skill content. This keeps the prompt small regardless of how many skills you have.

1. The system prompt lists available skills with their descriptions and paths
2. The agent decides which skill is relevant (no extra round-trip needed)
3. The agent calls `read_file` on the skill's `SKILL.md` to load full instructions when ready to use it

The `list_skills` tool is also available for broader discovery.

### Slash command

Users can force-load a skill directly:

```
> /skill:docker-deploy
> /skill:docker-deploy deploy the staging branch
```

This injects the full skill content into the conversation. Tab completion works for skill names.

## The Tool Loop

This is the core of how the agent works. After each LLM call, the agent checks if the response includes tool calls. If yes, it executes them and feeds the results back to the LLM.

```
LLM response
  ├─ Text only → done, emit response
  └─ Tool calls → for each tool call:
       ├─ Look up tool in registry
       ├─ Permission check (if tool.requiresPermission)
       │    └─ Emits permission:request async pipe → extensions decide
       ├─ Execute tool → get result (content + exitCode)
       ├─ Emit tool events (tool-started, tool-output-chunk, tool-completed)
       ├─ Add tool result to conversation
       └─ After all tools: call LLM again with updated conversation
```

The loop continues until the LLM returns a response with no tool calls. There's no hard limit on iterations — the LLM decides when it's done.

### Permission gating

Some tools require permission before executing. The agent emits a `permission:request` event through the async pipe, and extensions can approve or deny:

```typescript
const result = await bus.emitPipeAsync("permission:request", {
  kind: "tool-call",
  title: toolName,
  metadata: { args },
  decision: { outcome: "approved" },  // default: auto-approve (yolo mode)
});
if (result.decision.outcome !== "approved") {
  // return "Permission denied" as tool result — LLM sees this and adapts
}
```

In yolo mode (the default), everything is auto-approved. Load the `interactive-prompts` extension to add confirmation prompts.

Tools that require permission: **bash**, **write_file**, **edit_file** (anything that executes code or modifies files).

## Built-in Tools

The agent registers core tools on startup, with additional tools contributed by extensions in `~/.agent-sh/extensions/`.

### bash

The primary tool for investigation and code execution. **`bash`** runs in an **isolated subprocess** (`/bin/bash -c`). The agent uses this for reading files, running tests, checking state, and executing commands. A `cd` here doesn't affect your shell. Output is captured and returned to the LLM.

Extensions can add tools that cross the shell↔agent boundary via `shell:exec-request` — for example, running commands with lasting effects in the live PTY (`cd`, `export`, `source`). We don't include such a tool as built-in because the right behavior depends on user preference. See `examples/extensions/user_shell` for a ready-made implementation to start from.

### All tools

| Tool | Purpose | Permission | Modifies files |
|---|---|---|---|
| `bash` | Run commands in isolated subprocess | Yes | Yes |
| `read_file` | Read file contents (line-numbered, with offset/limit) | No | No |
| `write_file` | Create or overwrite a file | Yes | Yes |
| `edit_file` | Find-and-replace in a file (old_text → new_text) | Yes | Yes |
| `grep` | Search file contents with regex (via ripgrep) | No | No |
| `glob` | Find files by name pattern | No | No |
| `ls` | List directory contents (with timestamps and sizes) | No | No |
| `list_skills` | List available skills (name, description, path) | No | No |
| `conversation_recall` | Browse/search/expand evicted turns from the in-session archive and `~/.agent-sh/history` | No | No |

**Common pattern**: all file-based tools resolve relative paths from the current working directory (`contextManager.getCwd()`).

### Tool-specific enhancements

**`grep`** supports three output modes and pagination:

- `output_mode`: `files_with_matches` (default, file paths only), `content` (matching lines with optional `context_before`/`context_after`), or `count` (match counts per file)
- `case_insensitive`: case-insensitive search
- `head_limit` / `offset`: pagination — default limits are 200 entries for `files_with_matches`, 150 for `content`/`count`. Pass `head_limit=0` for unlimited. Long lines in `content` mode are capped at 500 characters.

**`read_file`** deduplicates reads:

- Tracks file modification time. If a file hasn't changed since the last read (same offset/limit), returns a stub instead of re-reading — saves context tokens.
- Files over 2MB require `offset` and `limit` to prevent OOM.
- Cache is automatically invalidated when a file-modifying tool (`write_file`, `edit_file`) succeeds on the same path.

**`edit_file`** provides diagnostic hints:

- When `old_text` isn't found, the tool searches for the closest match and suggests fixes (e.g. whitespace differences, wrong line location).

**`glob`** returns results sorted by modification time (newest first), capped at 200 files.

**`ls`** returns formatted output with timestamps (YYYY-MM-DD HH:MM) and human-readable file sizes.

### Tool batching and parallel execution

When the LLM requests multiple tool calls in a single response, the agent groups and executes them efficiently:

1. **Batch event** — before execution, the agent emits `agent:tool-batch` with tools grouped by kind (`read`, `search`, `execute`, etc.). The TUI uses this to render group headers with tree-style connectors.

2. **Parallel execution** — read-only tools (no `requiresPermission`, no `modifiesFiles`) run in parallel via `Promise.all`. Permission-requiring tools run sequentially to avoid overlapping permission prompts.

3. **Output truncation** — tool results over 16KB (~4K tokens) are head+tail truncated before being added to the conversation, preventing a single tool call from blowing through the context window.

### Structured result display

Tools can provide structured result information for the TUI via two optional methods on `ToolDefinition`:

- **`formatCall(args)`** — returns a short display string when the tool is called (e.g. the file path or search pattern). Shown in the TUI next to the tool icon.
- **`formatResult(args, result)`** — returns a `ToolResultDisplay` with an optional `summary` string (e.g. "42 files", "cached") and an optional structured `body` for richer rendering (diffs, line lists). The TUI's `render:result-body` handler renders the body — extensions can advise it.

### Retry and error handling

The agent retries transient failures with exponential backoff:

- **Context overflow** — compacts the conversation and retries immediately
- **Rate limits (429)** — respects `Retry-After` header, otherwise backs off exponentially
- **Transient errors (500/502/503, network)** — exponential backoff (1s, 2s, 4s..., capped at 30s), up to 3 retries
- **Non-retryable errors** — reported with provider-aware context (model name, endpoint, actionable hints)

### Thinking levels

The agent supports configurable thinking/reasoning levels for models that support `reasoning_effort`:

- Levels: `off` (default), `low`, `medium`, `high`
- Set via the `config:set-thinking` event (wired to `/thinking` slash command)
- Query current state via `config:get-thinking` pipe
- The agent validates that the current model/provider supports reasoning before enabling

### Tool interface

Every tool implements this interface:

```typescript
interface ToolDefinition {
  name: string;
  displayName?: string;           // short label for TUI (defaults to name)
  description: string;
  input_schema: Record<string, unknown>;  // JSON Schema for parameters

  execute(
    args: Record<string, unknown>,
    onChunk?: (chunk: string) => void,    // optional streaming callback
  ): Promise<ToolResult>;

  requiresPermission?: boolean;   // gate via permission:request
  modifiesFiles?: boolean;        // triggers file watcher
  showOutput?: boolean;           // stream output to TUI (default: true)

  // Display hooks (all optional)
  getDisplayInfo?: (args) => ToolDisplayInfo;  // icon, kind, file locations
  formatCall?: (args) => string;               // short call summary for TUI
  formatResult?: (args, result) => ToolResultDisplay;  // structured result
}

interface ToolResult {
  content: string;       // text returned to the LLM
  exitCode: number | null;
  isError: boolean;
}

interface ToolResultDisplay {
  summary?: string;      // one-line (e.g. "42 files", "+3/-1")
  body?: ToolResultBody; // structured content for richer rendering
}

type ToolResultBody =
  | { kind: "diff"; diff: unknown; filePath: string }
  | { kind: "lines"; lines: string[]; maxLines?: number }

interface ToolDisplayInfo {
  kind: "read" | "write" | "execute" | "search";
  locations?: { path: string; line?: number | null }[];
  icon?: string;         // custom icon (e.g. "◆", "⌕")
}
```

The `onChunk` callback enables streaming tool output to the TUI in real-time (used by `bash`). Tools that don't stream (like `read_file`) just return the final result. Extensions can wrap `onChunk` via the `tool:execute` handler to intercept or transform streamed output (e.g. secret redaction).

## Streaming

Response streaming has two phases:

**Phase 1 — LLM stream**: The agent iterates chunks from the OpenAI streaming API. Each chunk can contain:
- `delta.content` — response text
- `delta.tool_calls` — tool call arguments (streamed incrementally, parsed by index)
- `delta.reasoning_content` — thinking/reasoning tokens (non-standard, used by models like DeepSeek-r1)

**Phase 2 — Content transform pipeline**: Text chunks are emitted via `bus.emitTransform("agent:response-chunk", { blocks })`. This runs the content through the extension transform pipeline (parsers, post-transforms) before the renderer sees it. See [Extensions: Content Transform Pipeline](extensions.md#content-transform-pipeline).

The agent accumulates the full response text separately for the final `agent:response-done` event.

## Conversation State

The conversation state is an OpenAI-compatible chat messages array. Each query adds messages:

```
User submits query     → { role: "user", content: "fix the test" }
LLM responds with text → { role: "assistant", content: "I'll look at..." }
LLM requests tool call → { role: "assistant", tool_calls: [...] }
Tool returns result    → { role: "tool", tool_call_id: "...", content: "..." }
```

This array grows with every turn. To prevent context overflow, ash auto-compacts when estimated prompt tokens cross `autoCompactThreshold` (default 0.5) of the model's usable context window.

### Auto-compaction

Before each LLM call, ash estimates the total prompt tokens. If it's over the threshold, it invokes the `conversation:compact` handler to free space, then proceeds. If the API still returns a context-overflow error, ash compacts more aggressively and retries once; if compaction frees nothing, it aborts rather than looping.

The default compaction strategy evicts older turns into the nuclear archive and leaves a bridge note; `conversation_recall` can bring them back on demand. See [Context Management](context-management.md#conversation-compaction) for the three-tier design and how to swap the strategy.

The user can also trigger compaction manually with `/compact`.

**Note**: reasoning/thinking tokens from the LLM stream are emitted as `agent:thinking-chunk` events for display but are **not stored in conversation state**. They're ephemeral — the LLM doesn't see its own reasoning on the next turn.

## Provider Profiles & Model Switching

ash supports multiple models and providers, switchable at runtime.

### Modes

Each mode is a model + optional provider configuration:

```typescript
interface AgentMode {
  model: string;
  provider?: string;
  providerConfig?: {        // reconfigure LLM client on switch
    apiKey: string;
    baseURL?: string;
  };
  contextWindow?: number;   // per-model override for the auto-compact threshold
}
```

When all modes share the same provider, switching just changes the model name. When modes span providers (e.g. OpenAI + Anthropic via OpenRouter), switching also reconfigures the LLM client with different credentials and base URL.

### Switching

- **`/model`** — show the current model
- **`/model <name>`** — switch to a specific model (may cross providers; credentials and base URL are reconfigured automatically)

The current model is shown in the TUI prompt. Switching mid-conversation preserves the conversation state — only the LLM endpoint changes.

To swap the backend itself (e.g. to `claude-code` or `pi`), use `/backend <name>` or set `defaultBackend` in settings.

## Extension Tools

Extensions can register custom tools via `ctx.registerTool()`. These appear alongside built-in tools and follow the same `ToolDefinition` interface. Only works with the built-in `ash` backend — bridge backends manage their own tools.

See [Extensions: ExtensionContext API](extensions.md#extensioncontext-api) for the interface and [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for writing backend extensions.
