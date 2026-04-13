# Context Management

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

Both streams share a budget derived from the model's context window:

```
Model context window (e.g. 200,000 tokens)
  - System prompt + tool defs + response reserve
  = Content budget
    +-- Shell context (35% by default)
    +-- Conversation  (65% by default)
```

Configurable via `shellContextRatio` in settings. Recalculates on model switch. Falls back to 60k tokens when `contextWindow` is not set.

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

Full tool outputs, file contents, diffs — everything verbatim. This is what the LLM works with directly. Budget: `conversationBudgetTokens`.

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

When nuclear entries accumulate past `nuclearMaxEntries` (default 200), oldest entries flush to `~/.agent-sh/history` — a JSONL file that persists across restarts.

On startup, the last `historyStartupEntries` (default 50) entries are loaded so the agent knows what happened in prior terminal sessions.

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
| `contextBudget` | 16384 | Byte budget for shell context |
| `shellTruncateThreshold` | 10 | Shell output lines before truncation |
| `shellHeadLines` | 5 | Lines kept from start of truncated output |
| `shellTailLines` | 5 | Lines kept from end |
| `shellContextRatio` | 0.35 | Fraction of content budget for shell context |
| `recallExpandMaxLines` | 100 | Max lines shell_recall returns without line ranges |
| `historyMaxBytes` | 102400 | Max history file size (100KB) |
| `historyStartupEntries` | 50 | Prior history entries loaded on startup |
| `nuclearMaxEntries` | 200 | Max nuclear entries in-context before flushing to disk |

## Key Files

| File | Role |
|------|------|
| `src/context-manager.ts` | Shell exchange storage, windowing, truncation, recall API |
| `src/agent/conversation-state.ts` | Three-tier conversation: active + nuclear + history |
| `src/agent/nuclear-form.ts` | Nuclear one-liner generation, serialization, classification |
| `src/agent/history-file.ts` | Persistent JSONL history with append, search, truncation |
| `src/token-budget.ts` | Unified budget calculator |
| `src/agent/agent-loop.ts` | Wires budget, history, compaction + flush |
| `src/extensions/slash-commands.ts` | /compact, /context commands |
