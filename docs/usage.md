# Usage Guide

## Running agent-sh

After building, you can run agent-sh in several ways:

```bash
# Start with the default agent (pi-acp) - RECOMMENDED
npm start

# Quick shortcuts
npm run pi         # Start with pi-acp
npm run claude     # Start with claude-agent-acp (Anthropic's official Claude agent)

# Using the built binary directly
node dist/index.js --agent <agent-name>

# Using npm script with custom agent
npm start -- --agent <agent-name>

# Using npx (if published to npm)
npx agent-sh --agent <agent-name>

# Make the built file executable and run directly
chmod +x dist/index.js
./dist/index.js --agent <agent-name>

# Using environment variable to set default agent
AGENT_SH_AGENT=claude-agent-acp npm start
```

## Common Usage Patterns

```bash
# Start with the default agent (pi-acp)
npm start
# Shows: pi ● ❯ when entering agent mode

# Quick shortcuts
npm run pi         # pi-acp
npm run claude     # claude-agent-acp (Anthropic's official Claude agent)

# Start with a specific agent
npm start -- --agent pi-acp

# Pass arguments to the agent (including model)
npm start -- --agent claude-agent-acp --agent-args "--model claude-3-5-sonnet-20241022"
# Shows: claude-agent-acp (claude-3-5-sonnet-20241022) ● ❯ when entering agent mode

# Use pi-acp with Claude
npm start -- --agent pi-acp --agent-args "--provider anthropic --model claude-3-5-sonnet-20241022"
# Shows: pi (claude-3-5-sonnet-20241022) ● ❯

# Use pi-acp with OpenAI GPT-4
export OPENAI_API_KEY="your-openai-key"
npm start -- --agent pi-acp --agent-args "--provider openai --model gpt-4o"
# Shows: pi (gpt-4o) ● ❯

# Use a different shell
npm start -- --shell /bin/zsh

# Set default agent via environment variable
AGENT_SH_AGENT=claude-agent-acp npm start
```

## Common Claude Models

**Valid Claude model names** (for use with `--model` parameter):
- `claude-3-5-sonnet-20241022` (latest Sonnet)
- `claude-3-5-haiku-20241022` (latest Haiku)
- `claude-3-opus-20240229` (older Opus)
- `claude-3-sonnet-20240229` (older Sonnet)

**Example with claude-agent-acp**:
```bash
export ANTHROPIC_API_KEY="your-key"
npm start -- --agent claude-agent-acp --agent-args "--model claude-3-5-sonnet-20241022"
```

**Example with pi-acp**:
```bash
export ANTHROPIC_API_KEY="your-key"
npm start -- --agent pi-acp --agent-args "--provider anthropic --model claude-3-5-sonnet-20241022"
```

## Agent Environment Configuration

agent-sh can be configured via environment variables:

```bash
# Set the default agent to use
export AGENT_SH_AGENT=pi-acp  # Default is pi-acp
```

**Smart Connection**: agent-sh uses an intelligent connection system where the shell starts immediately and the agent connects in the background. If you send a query before the agent is fully connected, the system automatically waits for connection completion. This provides instant access to the shell while ensuring reliable agent communication.

Many ACP agents also require API keys. Set these before starting agent-sh:

### pi-acp configuration

pi-acp uses the same environment variables as the [pi](https://github.com/mariozechner/pi-coding-agent) agent:

```bash
# Anthropic Claude
export ANTHROPIC_API_KEY="your-anthropic-key"

# OpenAI
export OPENAI_API_KEY="your-openai-key"

# Google Gemini
export GEMINI_API_KEY="your-gemini-key"

# Groq
export GROQ_API_KEY="your-groq-key"

# xAI (Grok)
export XAI_API_KEY="your-xai-key"

# OpenRouter
export OPENROUTER_API_KEY="your-openrouter-key"
```

You can also configure pi-acp by passing arguments:

```bash
# Use Claude 3.5 Sonnet with pi-acp
npm start -- --agent pi-acp --agent-args "--provider anthropic --model claude-3-5-sonnet-20241022"
# Shows: pi (claude-3-5-sonnet-20241022) ● ❯

# Use GPT-4o with pi-acp
export OPENAI_API_KEY="your-openai-key"
npm start -- --agent pi-acp --agent-args "--provider openai --model gpt-4o"
# Shows: pi (gpt-4o) ● ❯

# Enable thinking mode
npm start -- --agent pi-acp --agent-args "--thinking high"

# Limit to read-only tools
npm start -- --agent pi-acp --agent-args "--tools read,grep,find,ls"
```

**Model Display**: When you specify a model using `--model`, it will be displayed in parentheses next to the agent name when you enter agent mode. This helps you quickly identify which model you're using.

For more pi-acp options, run `pi --help` (pi-acp accepts the same arguments).

### Other agent configurations

Refer to each agent's documentation for their specific environment variable requirements. Common patterns:

```bash
# claude-agent-acp (Anthropic's official Claude agent)
export ANTHROPIC_API_KEY="your-key"

# gemini-cli
export GOOGLE_API_KEY="your-key"
```

**Tip:** Add these to your `~/.zshrc` or `~/.bashrc` for persistent configuration.

## Shell Context

The agent automatically receives structured context about your shell session with each query, managed by the ContextManager:

- **Current working directory** — tracked via OSC 7 escape sequences
- **Recent commands and output** — truncated summaries of recent shell commands, agent queries, and tool executions
- **Recall tool** — the agent can run `__shell_recall --search "query"` or `__shell_recall --expand 42` to retrieve full output of any past exchange

This means you can run a failing command, then type `> fix this` and the agent knows exactly what happened. For long outputs, the agent sees a truncated summary and can recall the full content on demand.
