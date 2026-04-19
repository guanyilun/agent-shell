# Usage Guide

## Running agent-sh

The simplest way to run agent-sh — just provide an API key and model:

```bash
# Using environment variables
OPENAI_API_KEY="your-key" agent-sh --model gpt-4o

# Using CLI flags
agent-sh --api-key "your-key" --base-url http://localhost:11434/v1 --model llama3

# Using npx
npx agent-sh --api-key "$KEY" --model gpt-4o
```

Environment variables `OPENAI_API_KEY` and `OPENAI_BASE_URL` are supported as alternatives to CLI flags.

### Other Options

```bash
# Use a different shell
agent-sh --shell /bin/zsh

# Development mode (no build step)
npm run dev

# Debug mode
DEBUG=1 agent-sh --api-key "$KEY" --model gpt-4o
```

## Provider Examples

agent-sh works with any OpenAI-compatible API. Here are common configurations:

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
agent-sh --model gpt-4o
# or: agent-sh --model gpt-4o-mini
```

### Ollama (Local)

```bash
# No API key needed — Ollama doesn't require authentication
agent-sh --api-key dummy --base-url http://localhost:11434/v1 --model llama3
```

### OpenRouter

```bash
agent-sh --api-key "$OPENROUTER_KEY" \
  --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4-20250514
```

### Together AI

```bash
agent-sh --api-key "$TOGETHER_KEY" \
  --base-url https://api.together.xyz/v1 \
  --model meta-llama/Llama-3-70b-chat-hf
```

### Groq

```bash
agent-sh --api-key "$GROQ_KEY" \
  --base-url https://api.groq.com/openai/v1 \
  --model llama-3.3-70b-versatile
```

### LM Studio

```bash
agent-sh --api-key dummy \
  --base-url http://localhost:1234/v1 \
  --model local-model
```

### vLLM

```bash
agent-sh --api-key dummy \
  --base-url http://localhost:8000/v1 \
  --model your-model
```

## Overlay Agent (Ctrl+\)

The overlay agent is an optional extension that lets you summon the agent from anywhere — even inside vim, htop, or ssh — by pressing **Ctrl+\\**. Type a query, and the agent's response streams into a floating panel.

```bash
# Install the extension
cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/

# Or load directly
agent-sh -e ./examples/extensions/overlay-agent.ts
```

While the agent is working, press **Ctrl+\\** or **Esc** to hide the overlay and continue using your program — the agent keeps running in the background and control returns automatically when it finishes. If the overlay is still visible when the agent finishes, it shows a follow-up prompt for multi-turn conversation.

Requires `@xterm/headless` for the dimmed background compositing:
```bash
npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
```

## Using agent-sh as Your Default Shell

Add to the end of your `~/.zshrc` or `~/.bashrc`:

```bash
if [[ -z "$AGENT_SH" && $- == *i* && -t 0 ]]; then
  exec agent-sh --api-key "$OPENAI_API_KEY" --model gpt-4o
fi
```

The `AGENT_SH` guard prevents infinite recursion. The checks ensure it only launches for interactive terminal sessions.

## Configuration

agent-sh stores settings and query history in `~/.agent-sh/`. Configure via `~/.agent-sh/settings.json` — all fields are optional with sensible defaults.

### Provider Profiles

Instead of passing `--api-key` and `--base-url` every time, define named providers in settings.json:

```json
{
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "apiKey": "$OPENAI_API_KEY",
      "defaultModel": "gpt-4o",
      "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
      "contextWindow": 128000
    },
    "ollama": {
      "apiKey": "not-needed",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "llama3",
      "models": ["llama3", "mistral", "codellama"]
    },
    "openrouter": {
      "apiKey": "$OPENROUTER_KEY",
      "baseURL": "https://openrouter.ai/api/v1",
      "defaultModel": "anthropic/claude-sonnet-4.5",
      "models": [
        { "id": "anthropic/claude-sonnet-4.5", "contextWindow": 200000, "reasoning": true },
        { "id": "google/gemini-2.5-pro",       "contextWindow": 1000000 }
      ]
    }
  }
}
```

Then just run:

```bash
agent-sh                          # uses defaultProvider
agent-sh --provider ollama        # use a specific provider
agent-sh --provider openai --model gpt-4-turbo  # override the default model
```

The `apiKey` field supports `$ENV_VAR` and `${ENV_VAR}` syntax — variables are expanded at runtime, so you don't store secrets in the file.

### Declaring the context window

agent-sh adapts its auto-compaction trigger to the model's context window. There are two places to declare it:

- **Provider-level `contextWindow`** — applies to every model in that provider unless a more specific value is set.
- **Per-model `contextWindow`** (inside an entry of `models`) — overrides the provider-level value for a specific model, and also lets you tag reasoning-capable models via `reasoning: true`.

If neither is set, agent-sh falls back to a conservative 60k-token default.

Entries in `models` can be plain strings (just the model id, uses the provider-level `contextWindow`) or objects:

```json
"models": [
  "gpt-4o-mini",
  { "id": "gpt-4o",    "contextWindow": 128000 },
  { "id": "o1-preview", "contextWindow": 128000, "reasoning": true }
]
```

### Switching models at runtime

- **`/model`** — show the current model
- **`/model <name>`** — switch to a specific model (may cross providers; API key and base URL are reconfigured automatically)

Switching mid-conversation preserves your conversation state — only the LLM endpoint changes.

### CLI Flags

| Flag | Environment Variable | Description |
|---|---|---|
| `--provider <name>` | — | Use a named provider from settings.json |
| `--model <name>` | — | Model name (overrides provider default) |
| `--api-key <key>` | `OPENAI_API_KEY` | API key for OpenAI-compatible API |
| `--base-url <url>` | `OPENAI_BASE_URL` | Base URL for API endpoint |
| `--shell <path>` | `SHELL` | Shell to use (default: `/bin/bash`) |
| `-e, --extensions` | — | Extensions to load (comma-separated, repeatable) |

**Precedence** (highest to lowest): CLI flags → environment variables → provider profile in settings.json → defaults.

### General Settings

| Setting | Default | Description |
|---|---|---|
| `defaultProvider` | — | Which provider to use when no `--provider` flag is given |
| `defaultBackend` | `"ash"` | Which agent backend to activate. Set to an extension backend name (e.g. `"claude-code"`, `"pi"`) to use it by default |
| `extensions` | `[]` | Extensions to load (npm packages or file paths) |
| `historySize` | `500` | Max agent query history entries (persisted across sessions) |
| `shellTruncateThreshold` | `20` | Shell output lines before spill-to-tempfile |
| `shellHeadLines` / `shellTailLines` | `10` / `10` | Lines kept from start/end when output is spilled |
| `autoCompactThreshold` | `0.5` | Fraction of the model's context window at which conversation auto-compacts |
| `historyMaxBytes` | `104857600` | Max size of `~/.agent-sh/history` before front-truncation (100MB) |
| `historyStartupEntries` | `100` | Prior history entries injected as `[Prior session history]` preamble on launch |
| `maxCommandOutputLines` | `3` | Max tool output lines shown inline in TUI |
| `readOutputMaxLines` | `10` | Max read tool output lines shown inline (0 = hidden) |
| `diffMaxLines` | `Infinity` | Max diff lines rendered in the TUI. Defaults to no limit |
| `skillPaths` | `[]` | Extra directories to scan for skills (supports `~` expansion) |
| `diagnose` | `false` | Enable the `diagnose` tool — lets the agent evaluate JS expressions against its own runtime state (introspection; agent already has bash, so this is convenience, not new capability) |
| `startupBanner` | `true` | Show the startup banner (backend / model / extensions / skills) on launch |
| `promptIndicator` | `true` | Show a subtle agent-sh indicator in the shell prompt |
| `toolMode` | `"api"` | How tools are presented to the LLM. `"api"` sends all tool schemas. `"deferred"` bundles extension tools behind a `use_extension(name, args)` meta-tool (saves prompt tokens, loses schema fidelity). `"deferred-lookup"` keeps extension schemas dormant until the model calls `load_tool(names[])` — loaded tools then become first-class on the next turn with full schemas. `"inline"` describes tools as text. |
| `disabledExtensions` | `[]` | Names of user extensions in `~/.agent-sh/extensions/` to skip when auto-discovering. Match by basename without extension for files (`"peer-mesh"` matches `peer-mesh.ts`) or by directory name for dir-style extensions (`"superash"` matches `superash/index.ts`). Avoids having to rename files to `.disabled`. |
| `disabledBuiltins` | `[]` | Names of built-in extensions to disable. |

## Startup Banner

On launch, agent-sh displays a structured startup banner showing:

- **Backend** — which agent backend is active (`ash`, `claude-code`, `pi`, etc.)
- **Model** — current model with provider in brackets (e.g. `gpt-4o [openai]`)
- **Extensions** — loaded extensions (from CLI `-e`, settings, or `~/.agent-sh/extensions/`)
- **Skills** — discovered skills (global + project)

Set `startupBanner: false` in settings to disable.

## Shell Context

The agent automatically receives structured context about your shell session with each query:

- **Current working directory** — tracked via OSC 7 escape sequences
- **Recent commands and output** — new shell activity since the last turn is injected as a `<shell-events>` delta prepended to your query
- **Long outputs are spilled to tempfiles** — outputs over `shellTruncateThreshold` lines are written to `<tmpdir>/agent-sh-<pid>/<id>.out` at capture; the agent sees head+tail plus the path and recovers the full text via the built-in `read_file` tool

This means you can run a failing command, then type `> fix this` and the agent knows exactly what happened — including a pointer to the full output if it got truncated. See [Context Management](context-management.md) for the full design.

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/model [name]` | Show current model; with a name, switch to that model |
| `/backend [name]` | List backends, or switch to a named backend |
| `/thinking [level]` | Set reasoning effort (off, low, medium, high) |
| `/compact` | Compact conversation (free up context space) |
| `/context` | Show context budget usage (active tokens vs. budget) |
| `/reload` | Reload user extensions from `~/.agent-sh/extensions/` |

See [Context Management](context-management.md) for how `/compact` and `/context` work, and [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for `/backend`.
