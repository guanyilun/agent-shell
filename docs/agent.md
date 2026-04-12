# Internal Agent

The internal agent (AgentLoop) is the default backend when you provide `--api-key` and `--model`. It calls any OpenAI-compatible API directly, manages conversation state, and executes tools in a loop until the LLM is done.

## The Query Flow

Here's what happens when you submit a query:

```
User types "? fix the failing test"
  │
  ├─ 1. Context assembly — gather recent shell commands, output, cwd
  ├─ 2. System prompt — tools + context + guidelines, rebuilt every call
  ├─ 3. LLM call — stream response from the API
  ├─ 4. Tool loop — if LLM requested tool calls:
  │     ├─ Execute each tool (with permission check if needed)
  │     ├─ Add results to conversation
  │     └─ Go back to step 3 (LLM sees tool results, decides next action)
  └─ 5. Done — no more tool calls, emit response
```

The key insight: **the agent is a loop, not a single call**. The LLM calls tools, sees results, calls more tools, until it has enough information to respond. A single query might trigger dozens of LLM calls and tool executions.

## Context Assembly

Every query includes **shell context** — a structured summary of your recent terminal activity. This is how the agent knows what you've been doing.

```
Shell Context (from ContextManager):
  ├─ Current working directory
  ├─ Recent shell commands + truncated output
  ├─ Recent agent exchanges (queries + responses)
  └─ Recent tool executions
```

Context is **not the same as conversation state**. This is a common source of confusion:

- **Shell context** = your terminal history, assembled fresh for every LLM call, included in the system prompt. It's what lets the agent understand "fix this" after you ran a failing command.
- **Conversation state** = the OpenAI chat messages array (`user`/`assistant`/`tool` messages). This is the LLM's memory of the current multi-turn conversation.

They serve different purposes. Context gives the agent situational awareness. Conversation state gives it memory of what it already said and did.

### Truncation and budgeting

Shell output can be large. The context manager applies a budget to keep things reasonable:

- **Windowing** — only the last N exchanges are included (configurable via `contextWindowSize`)
- **Per-exchange truncation** — long outputs get head+tail with `[... omitted ...]` in the middle
- **Budget enforcement** — if total context exceeds the byte budget, oldest exchange outputs are stripped first
- **Recall** — the agent can use `shell_recall` to retrieve full output of truncated exchanges when needed

## System Prompt

The system prompt is rebuilt on **every LLM call** (not cached), so context is always fresh. It includes:

1. **Identity** — "You are an AI coding assistant in agent-sh..."
2. **Input modes** — instructions for execute mode vs help mode
3. **Available tools** — name + description of every registered tool
4. **Tool usage guidelines** — read before editing, prefer edit over write, use grep/glob to find files, etc.
5. **Shell context** — the assembled context from above
6. **Metadata** — current date, working directory

The per-query **mode instruction** (e.g. `[mode: execute]` or `[mode: help]`) is prepended to the user message, not the system prompt. This tells the agent how to behave for this specific query.

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

Skills are **not** loaded into the system prompt. Instead:

1. The system prompt tells the agent how many skills are available
2. The agent calls `list_skills` to see names, descriptions, and file paths
3. The agent calls `read_file` on the relevant `SKILL.md` to load full instructions

This keeps the system prompt small regardless of how many skills you have.

### Slash command

Users can force-load a skill directly:

```
? /skill:docker-deploy
? /skill:docker-deploy deploy the staging branch
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

The agent has 8 built-in tools. The most important distinction is between `bash` and `user_shell` — they look similar but work completely differently.

### bash vs user_shell

These two tools both run shell commands, but in **different worlds**:

- **`bash`** — runs in an **isolated subprocess** (`/bin/bash -c`). The agent uses this for investigation: reading files, running tests, checking state. A `cd` here doesn't affect your shell. Output is captured and returned to the LLM.
- **`user_shell`** — runs in **your live PTY**. The agent uses this for commands that should affect your shell: `cd`, `export`, `source`, `npm install`, anything the user needs to see. Output appears in your terminal directly.

Why the split? Two reasons:

1. **Safety** — bash runs in isolation, so the agent can't accidentally break your shell state. user_shell is the explicit "touch the user's environment" action.
2. **Token efficiency** — user_shell returns `"Command executed"` by default instead of the full output. The user already sees it in the terminal; sending it back to the LLM wastes tokens. The agent can pass `return_output: true` when it actually needs to read the result.

### All tools

| Tool | Purpose | Permission | Modifies files |
|---|---|---|---|
| `bash` | Run commands in isolated subprocess | Yes | Yes |
| `user_shell` | Run commands in user's live PTY | No | Yes |
| `read_file` | Read file contents (line-numbered, with offset/limit) | No | No |
| `write_file` | Create or overwrite a file | Yes | Yes |
| `edit_file` | Find-and-replace in a file (old_text → new_text) | Yes | Yes |
| `grep` | Search file contents with regex (via ripgrep) | No | No |
| `glob` | Find files by name pattern | No | No |
| `ls` | List directory contents | No | No |

**Common pattern**: all file-based tools resolve relative paths from the current working directory (`contextManager.getCwd()`).

### Tool interface

Every tool implements this interface:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;  // JSON Schema for parameters

  execute(
    args: Record<string, unknown>,
    onChunk?: (chunk: string) => void,    // optional streaming callback
  ): Promise<ToolResult>;

  requiresPermission?: boolean;   // gate via permission:request
  modifiesFiles?: boolean;        // triggers file watcher
  showOutput?: boolean;           // stream output to TUI (default: true)
}

interface ToolResult {
  content: string;       // text returned to the LLM
  exitCode: number | null;
  isError: boolean;
}
```

The `onChunk` callback enables streaming tool output to the TUI in real-time (used by `bash`). Tools that don't stream (like `read_file`) just return the final result.

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

This array grows with every turn. To prevent context overflow, the agent auto-compacts when the estimated token count exceeds ~60K tokens.

### Auto-compaction

When the conversation gets too long:

1. Estimate tokens (~4 chars per token, conservative)
2. If over threshold, keep the **first message** (original task) + the **last N turns** + a bridge message: `"[Earlier conversation turns omitted for context space]"`
3. Retry the LLM call with the compacted conversation
4. If it still overflows, compact more aggressively (fewer turns) and retry once

This is separate from the `/compact` slash command, which the user can trigger manually.

**Note**: reasoning/thinking tokens from the LLM stream are emitted as `agent:thinking-chunk` events for display but are **not stored in conversation state**. They're ephemeral — the LLM doesn't see its own reasoning on the next turn.

## Provider Profiles & Model Cycling

The agent supports multiple models and providers, switchable at runtime.

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
}
```

When all modes share the same provider, cycling just changes the model name. When modes span providers (e.g. OpenAI + Anthropic via OpenRouter), cycling also reconfigures the LLM client with different credentials and base URL.

### Switching

- **Shift+Tab** or **`/model`** — cycle to the next mode in the list
- **`/provider <name>`** — switch to a different provider's model list

The current model is shown in the TUI prompt. Switching mid-conversation preserves the conversation state — only the LLM endpoint changes.

## Extension Tools

Extensions can register custom tools via `ctx.registerTool()`. These appear alongside built-in tools and follow the same `ToolDefinition` interface. Only works with the built-in `agent-sh` backend — bridge backends manage their own tools.

See [Extensions: ExtensionContext API](extensions.md#extensioncontext-api) for the interface and [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for writing backend extensions.
