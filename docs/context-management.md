# Context Management

## Design Philosophy

Most coding agents treat context as a session problem — you start a chat, work on something, and eventually the context fills up or you start a new session. This works when the agent owns the entire interaction, but agent-sh is different: **we live in a terminal.**

The terminal is continuous. You run commands, switch between tasks, help a colleague, come back to what you were doing. Nobody thinks about "sessions" when using a shell. Shell history is just *there* — always available, always growing, persisting across restarts. You never manage it, but you can always search it.

This is the model agent-sh follows for context management:

**No sessions.** There's no "new session" or "clear." History is continuous and append-only, like `.zsh_history`. Old content naturally rolls through tiers of decreasing resolution — full content, then one-liner summaries, then a persistent file on disk.

**No assumptions about workflow.** We don't try to detect topic changes, time gaps, or "the user has moved on." If someone asks about React after a database discussion, maybe they're helping a colleague for 30 seconds. Any heuristic that guesses intent will be wrong often enough to be annoying. The only reason to evict content is mechanical: the context window is full and we need space.

**Two streams, no duplication.** The user's shell activity and the agent's work are fundamentally different kinds of information. Shell context provides situational awareness ("what has the user been doing?"). Conversation provides task continuity ("what has the agent been working on?"). They should share a budget but never duplicate content.

**Graceful degradation.** When context is evicted, it doesn't vanish — it compresses. Full tool outputs become one-liner summaries that stay in-context. The agent always has a timeline of the entire session at decreasing resolution, and can recover full content on demand via recall tools.

**Model-aware.** A 200k context model should behave differently from an 8k model. The token budget adapts to the model's actual context window, not a hardcoded threshold.

## How It Works

agent-sh manages context like shell history — it's always there, it persists across restarts, there are no explicit sessions. Content flows through three tiers at decreasing resolution, ensuring the agent always has a timeline of what happened while keeping within the model's context window.

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

**Compaction uses API-grounded token counts.** The auto-compact threshold is based on real `prompt_tokens` from the LLM API response, not the chars/4 heuristic. After each API call, the reported `prompt_tokens` (total input including system prompt, tools, context, and conversation) is captured. On the next iteration, `estimatePromptTokens()` returns the last API value plus a rough estimate for any messages added since. This gives near-exact threshold checks without extra API calls.

When compaction fires, the threshold is converted internally from total-prompt space to conversation-only space so the eviction loop can operate with its per-turn chars/4 estimates. After compaction, the API baseline resets — the next API call provides a fresh ground-truth measurement.

## Three-Tier Conversation History

This is the core design. Content flows downward as the context window fills:

```
Tier 1: Active Context          full content in LLM conversation
  | compacts when budget fills
  | read-only items dropped, state-changing -> nuclear one-liner
  | full content -> recall archive (in-memory)
  v
Tier 2: Nuclear Memory          one-liners IN the conversation + recall archive
  | flushes when nuclear entries exceed threshold
  | entries written to disk, removed from memory
  v
Tier 3: History File            ~/.agent-sh/history, JSONL, append-only
  | truncated from front at fixed file size
```

### Tier 1: Active Context

Full tool outputs, file contents, diffs — everything verbatim. This is what the LLM works with directly. Compacts when total prompt tokens approach the context window.

### Tier 2: Nuclear Memory

When Tier 1 fills, low-priority turns are **compacted** into nuclear one-liners that stay in the conversation. The LLM always sees a timeline:

```
[Conversation history — use conversation_recall to expand any entry]
#12 14:01 user: "Set up the project with TypeScript..."
#13 14:02 bash: npm init -y (exit 0, 8 lines)
#15 14:03 write_file tsconfig.json (created, 15 lines)
#16 14:03 edit_file package.json (+2/-1)
#18 14:05 user: "Now add the test framework"
```

Key behaviors:
- **Read-only items are dropped** — `read_file`, `grep`, `glob`, `ls` results vanish (the agent can re-read them)
- **State-changing actions survive** — `edit_file`, `write_file`, `bash` (with exit codes), errors, user messages
- **Full content is archived** in memory for `conversation_recall`

### Tier 3: History File

Nuclear entries are eagerly written to `~/.agent-sh/history` — a JSONL file that persists across restarts — as they arrive. They also stay in memory for the nuclear block injected into context.

On startup, the last `historyStartupEntries` (default 100) non-read-only entries are loaded so the agent knows what happened in prior terminal sessions. Read-only tools (`read_file`, `grep`, `glob`, `ls`) are filtered out at load time to maximize the number of meaningful entries.

**Multi-shell**: Multiple agent-sh instances share the same history file. Each line is well under PIPE_BUF, so `O_APPEND` writes are atomic. Only file truncation (when exceeding `historyMaxBytes`) uses a lock file.

**Format**: One JSON object per line, inspectable with `jq`:
```json
{"seq":44,"ts":1713020580000,"iid":"a3f2","kind":"tool","tool":"edit_file","sum":"edit_file src/types.ts (+3/-1)"}
```

### Priority-based compaction

Not all turns are equally important. Compaction evicts lowest-priority content first:

| Priority | What | Why |
|----------|------|-----|
| Pinned | First user message + last N turns | Original task + recency |
| High | User messages, error messages, assistant reasoning | Context and corrections matter |
| Medium | Tool results from write/edit operations | Produced durable changes |
| Low | Successful tool results with no errors | Can be reproduced |
| Lowest | Read-only tool results (grep, ls, read_file) | Agent can re-read these |

## Shell Context Pipeline

Shell context passes through three stages:

1. **Windowing** — last N exchanges (default 20, configurable via `contextWindowSize`)
2. **Per-exchange truncation** — long outputs get head+tail (configurable thresholds)
3. **Budget enforcement** — oldest outputs stripped if over token budget

The agent can recover full content via `shell_recall`.

## Recall Tools

### shell_recall

Recovers truncated shell context:
- `shell_recall` — browse recent exchanges
- `shell_recall --search "query"` — regex search
- `shell_recall --expand 41` — full content of exchange #41

### conversation_recall

Recovers compacted conversation content across all tiers:
- `conversation_recall browse` — list nuclear entries + recent history
- `conversation_recall --search "query"` — search archive + history file
- `conversation_recall --expand 5` — full content from recall archive

## Slash Commands

| Command | Action |
|---------|--------|
| `/compact` | Manually trigger compaction (Tier 1 → Tier 2) |
| `/context` | Show context budget usage (active tokens, nuclear entries, archive size) |

History is continuous — there's no `/clear`. Old content naturally rolls through the tiers. Use `/compact` if you want to free up active context space immediately.

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
| `recallExpandMaxLines` | 500 | Max lines recall expand returns without line ranges |
| `historyMaxBytes` | 104857600 | Max history file size (100MB) |
| `historyStartupEntries` | 100 | Prior history entries loaded on startup (read-only tools filtered) |

## Key Files

| File | Role |
|------|------|
| `src/context-manager.ts` | Shell exchange storage, windowing, truncation, recall API |
| `src/agent/conversation-state.ts` | Three-tier conversation: active + nuclear + history. Token estimation (API-grounded + chars/4 fallback). |
| `src/agent/nuclear-form.ts` | Nuclear one-liner generation, serialization, classification |
| `src/agent/history-file.ts` | Persistent JSONL history with append, search, truncation |
| `src/agent/token-budget.ts` | Shell context budget calculator. Exports `RESPONSE_RESERVE`, `DEFAULT_CONTEXT_WINDOW`. |
| `src/agent/agent-loop.ts` | Wires budget, API token feedback, compaction + flush |
| `src/extensions/slash-commands.ts` | /compact, /context commands |
