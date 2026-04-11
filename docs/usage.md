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
      "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"]
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
      "defaultModel": "anthropic/claude-sonnet-4-20250514",
      "models": ["anthropic/claude-sonnet-4-20250514", "google/gemini-2.5-pro"]
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

### Model Cycling

When a provider has multiple `models`, you can cycle through them at runtime:

- **Shift+Tab** or **`/model`** — switch to the next model in the list
- **`/provider <name>`** — switch to a different provider entirely

The current model is shown in the prompt. Switching mid-conversation preserves your conversation state — only the LLM endpoint changes.

When cycling across providers (e.g. from OpenAI to Ollama), the API key and base URL are reconfigured automatically.

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
| `defaultBackend` | `"agent-sh"` | Which agent backend to activate. Set to an extension backend name (e.g. `"claude-code"`, `"pi"`) to use it by default |
| `extensions` | `[]` | Extensions to load (npm packages or file paths) |
| `historySize` | `500` | Max agent query history entries (persisted across sessions) |
| `contextWindowSize` | `20` | Recent exchanges included in agent context |
| `contextBudget` | `16384` | Context budget in bytes (~4K tokens) |
| `shellTruncateThreshold` | `10` | Shell output lines before truncation |
| `shellHeadLines` / `shellTailLines` | `5` / `5` | Lines kept from start/end of truncated output |
| `recallExpandMaxLines` | `100` | Max lines for recall expand |
| `maxCommandOutputLines` | `3` | Max tool output lines shown inline in TUI |
| `readOutputMaxLines` | `0` | Max read tool output lines shown inline (0 = hidden) |
| `diffMaxLines` | `20` | Max diff lines before "ctrl+o to expand" |
| `enableMcp` | `true` | Register MCP server for bridge tools |

## Shell Context

The agent automatically receives structured context about your shell session with each query:

- **Current working directory** — tracked via OSC 7 escape sequences
- **Recent commands and output** — truncated summaries of recent shell activity
- **Full history access** — the agent can recall full output of truncated exchanges

This means you can run a failing command, then type `? fix this` and the agent knows exactly what happened. Context size is tunable via settings.
