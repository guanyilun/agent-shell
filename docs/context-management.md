# Context Management

## Design Philosophy

Most coding agents treat context as a session problem — you start a chat, work on something, and eventually the context fills up or you start a new session. This works when the agent owns the entire interaction, but agent-sh is different: **we live in a terminal.**

The terminal is continuous. You run commands, switch between tasks, help a colleague, come back to what you were doing. Nobody thinks about "sessions" when using a shell. Shell history is just *there* — always available, always growing, persisting across restarts. You never manage it, but you can always search it.

This is the model agent-sh follows for context management:

**No sessions.** There's no "new session" or "clear." History is continuous and append-only, like `.zsh_history`.

**No assumptions about workflow.** We don't try to detect topic changes, time gaps, or "the user has moved on." If someone asks about React after a database discussion, maybe they're helping a colleague for 30 seconds. Any heuristic that guesses intent will be wrong often enough to be annoying. The only reason to evict content is mechanical: the context window is full and we need space.

**Two streams, no duplication.** The user's shell activity and the agent's work are fundamentally different kinds of information. Shell context provides situational awareness ("what has the user been doing?"). Conversation provides task continuity ("what has the agent been working on?"). They share a budget but never duplicate content.

**Model-aware.** A 200k context model should behave differently from an 8k model. The token budget adapts to the model's actual context window, not a hardcoded threshold.

**Strategy is pluggable.** The kernel decides *when* to compact (threshold crossing, explicit `/compact`, overflow retry). *How* to compact lives behind the advisable `conversation:compact` handler. The built-in agent ships a shell-history-shaped default: every message is nucleated into a one-line summary and appended to `~/.agent-sh/history` as it arrives; when the window fills, lower-priority turns are evicted and replaced in context by their summaries, recoverable through `conversation_recall`. Extensions advise the handler to install richer strategies (LLM summarisation, topic pinning, etc.) but the flow itself — nucleate, append, evict — stays continuous.

## The Two Streams

### Shell Context (situational awareness)

Managed by `ContextManager`, injected as `<shell_context>` on every LLM call.

Contains only user-initiated activity:
- User shell commands and outputs (truncated)
- Agent query markers

### Conversation (task continuity)

Managed by `ConversationState`, appended to the LLM messages array.

Contains agent work:
- User messages, assistant messages, tool calls, tool results

No duplication — agent tool outputs live only in the conversation stream.

## Token Budget

Shell context is sized using a rough budget derived from the model's context window:

```
Model context window (e.g. 200,000 tokens)
  - System prompt + tool defs + response reserve (estimated overhead)
  = Content budget
    +-- Shell context (35% by default, via shellContextRatio)
```

Configurable via `shellContextRatio` in settings. Recalculates on model switch. Falls back to 60k tokens when `contextWindow` is not set.

**Compaction checks use API-grounded token counts.** The auto-compact threshold is based on real `prompt_tokens` from the LLM API response, not the chars/4 heuristic. After each API call, the reported `prompt_tokens` (total input including system prompt, tools, context, and conversation) is captured. On the next iteration, `estimatePromptTokens()` returns the last API value plus a rough estimate for any messages added since.

## Compaction Hook

When the kernel detects that compaction is warranted, it invokes the `conversation:compact` handler. This handler is advisable — extensions wrap it to implement their own strategy.

**Default (built-in agent):** three-tier priority-based compaction.
- Every message is nucleated eagerly on arrival into a one-line summary and appended to the persistent history file at `~/.agent-sh/history` (JSONL, append-only, concurrency-safe). Read-only tool results are skipped for disk writes — the agent can re-run them.
- Active context: full messages + a rolling in-context "nuclear block" (the one-liners) + an in-memory recall archive keyed by seq.
- When conversation size exceeds the target, `compact()` keeps the first turn and the last `keepRecent` turns (verbatim plus slimmed), scores the rest by priority × recency, and evicts lowest-priority turns first. Evicted turns collapse into their one-liners; the full text remains searchable via `conversation_recall` (in-memory for this session, history file for prior sessions).
- On startup, the most recent entries from the history file are injected as a `[Prior session history]` preamble so context carries across restarts.

**With a strategy extension:** the advisor replaces the default. It reads the messages array (via `conversation:get-messages`), computes a replacement, installs it via `conversation:replace-messages`, and returns `{ before, after, evictedCount }`. Useful override points:
- LLM-summarised compaction (summarise evicted turns before eviction)
- Topic pinning (preserve turns matching pinned keywords)
- Alternate persistence backends (SQLite, remote, etc.)

Observation hook: `conversation:message-appended` fires every time a message is added to the conversation (user/assistant/tool), allowing extensions to build rolling indexes, summarise content, or feed memory systems.

## Shell Context Pipeline

Shell context passes through three stages:

1. **Windowing** — last N exchanges (default 20, configurable via `contextWindowSize`)
2. **Per-exchange truncation** — long outputs get head+tail (configurable thresholds)
3. **Budget enforcement** — oldest outputs stripped if the windowed total exceeds the byte budget

Long outputs are spilled to a tempfile at capture time (`<tmpdir>/agent-sh-<pid>/<id>.out`). The in-memory exchange keeps head + tail + path; the stub reads `[... N lines truncated — full output at /path/42.out; use read_file to expand ...]`.

### Budget enforcement vs. compaction

These are related but distinct mechanisms:

| | Budget enforcement (shell) | Compaction (conversation) |
|---|---|---|
| **Stream** | Shell context (`<shell_context>` block) | Conversation messages array |
| **When** | Every call to `getContext()` (every turn) | On threshold crossing, `/compact`, or overflow retry |
| **State change** | None — operates on a shallow clone; original exchanges untouched | Mutates the messages array; evicted turns collapse to one-liners |
| **Recovery** | Full text still on disk (spill file) + in memory | Full text in in-memory archive + history file |
| **Tool to expand** | `read_file` on the spill path | `conversation_recall` |

In short: budget enforcement is transient per-turn trimming of *presentation*. Compaction is persistent state transformation of the conversation. They can fire in the same turn without interacting.

## Recall

### Shell output (read_file on spill path)

Long shell outputs aren't kept verbatim in LLM context. Instead:

- On capture, if output exceeds `shellTruncateThreshold` lines, the full text is written to `<tmpdir>/agent-sh-<pid>/<id>.out`.
- The in-context representation shows `shellHeadLines` from the top and `shellTailLines` from the bottom, with a marker pointing at the spill path.
- The agent recovers full content with the existing `read_file` tool on that path — no dedicated recall tool needed. `read_file`'s offset/limit handle pagination for very large outputs.

The session dir is removed on process exit (including SIGINT/SIGTERM/SIGHUP). Stale dirs from dead processes are swept lazily the next time a session starts.

### conversation_recall (agent tool)

Recovers evicted conversation turns:
- `conversation_recall {"action": "browse"}` — list in-context nuclear entries + recent history file entries
- `conversation_recall {"action": "search", "query": "..."}` — regex search across the in-session archive and the history file (both summary + body)
- `conversation_recall {"action": "expand", "turn_id": 42}` — full content of a specific turn

The tool is registered by the built-in agent; extensions that replace the compaction strategy can either reuse it or advise it with their own semantics.

## Slash Commands

| Command | Action |
|---------|--------|
| `/compact` | Fire the `conversation:compact` handler (effective behavior depends on active advisors) |
| `/context` | Show context budget usage (active tokens, total tokens, budget) |

History is continuous — there's no `/clear`.

## Configuration

All settings in `~/.agent-sh/settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `contextWindowSize` | 20 | Max recent shell exchanges in context |
| `contextBudget` | 32768 | Byte budget for shell context |
| `shellTruncateThreshold` | 20 | Shell output lines before truncation |
| `shellHeadLines` | 10 | Lines kept from start of truncated output |
| `shellTailLines` | 10 | Lines kept from end |
| `shellContextRatio` | 0.35 | Fraction of content budget for shell context |
| `autoCompactThreshold` | 0.5 | Fraction of context window at which auto-compact triggers |
| `historyMaxBytes` | 104857600 | Max size of `~/.agent-sh/history` before rotation |
| `historyStartupEntries` | 100 | Prior history entries loaded as a preamble on startup |

## Key Files

| File | Role |
|------|------|
| `src/context-manager.ts` | Shell exchange storage, windowing, truncation, recall API |
| `src/agent/conversation-state.ts` | Messages + eager nucleation + two-tier pin compaction + recall (search/expand/browse) |
| `src/agent/nuclear-form.ts` | One-line-summary primitives (nucleate, serialize, priority classification) |
| `src/agent/history-file.ts` | Append-only JSONL at `~/.agent-sh/history`, chunked search/tail-read, front-truncation |
| `src/agent/token-budget.ts` | Shell context budget calculator. Exports `RESPONSE_RESERVE`, `DEFAULT_CONTEXT_WINDOW` |
| `src/agent/agent-loop.ts` | Wires budget, API token feedback, auto-compact trigger, invokes `conversation:compact` advisor chain, registers `conversation_recall` |
| `src/extensions/slash-commands.ts` | /compact, /context commands |
