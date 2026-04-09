# agent-sh

Not a shell that lives in an agent — an agent that lives in a shell.

agent-sh is a real terminal first. Every keystroke goes to a real PTY. `cd`, pipes, vim, job control — they all just work. But type `>` at the start of a line, and you're talking to an AI agent that has full context of what you've been doing: your working directory, recent commands, their output.

The agent connects via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), so you can plug in **any** ACP-compatible agent: [pi](https://github.com/svkozak/pi-acp), claude-code, codex, gemini-cli, goose, etc.

```
⚡ src $ ls -la                          # real shell command
⚡ src $ cd ../tests && npm test          # real cd, env, aliases — all just work
⚡ src $ vim file.ts                      # opens vim in the same PTY
⚡ src $ > refactor the auth middleware   # → sent to agent via ACP
⚡ src $ > explain the last error         # agent sees your recent commands + output
```

## Why shell-first?

Most AI coding tools are agent-first: the LLM drives the experience and the shell is bolted on. That means no real PTY, no job control, no interactive commands, and fragile `cd` tracking that reimplements what bash gives you for free.

agent-sh starts from the opposite end. The shell is the primary interface — it's your terminal, not the agent's. The agent is a tool you reach for when you need it, not the other way around.

### Why ACP?

The [Agent Client Protocol](https://agentclientprotocol.com/) decouples the shell from any specific agent:

- **Pluggable agents** — swap between pi-acp, claude-code, codex with a CLI flag
- **Standard protocol** — JSON-RPC 2.0 over stdio, well-specified capability negotiation
- **Agent handles LLM details** — no API keys, tool definitions, or context windows to manage
- **Terminal delegation** — ACP defines `terminal/create`, `terminal/output`, `terminal/wait_for_exit` — exactly what an agent needs to run commands in your shell

## Key Features

- **🚀 Instant Start** — Shell starts immediately, no waiting for agent connection
- **🔄 Smart Connection** — Agent connects asynchronously in the background
- **⏳ Auto-Wait** — Queries automatically wait for agent to finish connecting
- **📊 Real-time Streaming** — Agent responses stream live with syntax highlighting
- **⚡ Zero Latency** — Direct PTY access, full terminal compatibility
- **🧠 Context Aware** — Agent sees your cwd, recent commands, and their output
- **🎯 Multiple Agents** — Easy switching between pi-acp, claude, and other ACP agents
- **🏷️ Agent Info Display** — Shows current agent and model next to the prompt (e.g., `pi (gpt-4o) ●`)
- **📝 Inline Diff Preview** — File writes show syntax-highlighted diffs inline (Ctrl+O to expand)
- **💭 Thinking Display** — Toggle agent thinking/reasoning text with Ctrl+T
- **🎨 Themeable** — Semantic color palette, swappable via extensions

## Install

```bash
git clone https://github.com/guanyilun/agent-sh.git
cd agent-sh
npm install
npm run build
```

Requires Node.js 18+ and an ACP-compatible agent installed on your system.

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

### Install ACP-compatible agents

agent-sh requires an ACP-compatible agent. Here are some popular options:

| Agent | Install Command | Notes |
|-------|----------------|-------|
| **pi-acp** | `npm install -g pi-acp` | **Recommended default** - ACP adapter for pi coding agent |
| **claude-agent-acp** | `npm install -g @agentclientprotocol/claude-agent-acp` | Anthropic's official ACP Claude agent |

**⚠️ Important**: The `claude` CLI tool (Claude Code) does **not** support the ACP protocol. You must use `claude-agent-acp` or `pi-acp` with Anthropic models.

**Example: Installing pi-acp**
```bash
npm install -g pi-acp
pi-acp --help  # Verify installation
```

## Usage

### Quick Start

```bash
# 1. Install required agents (if not already installed)
npm install -g pi-acp
npm install -g @agentclientprotocol/claude-agent-acp

# 2. Set required API keys
export ANTHROPIC_API_KEY="your-anthropic-api-key"
# Or for OpenAI models with pi-acp:
# export OPENAI_API_KEY="your-openai-api-key"

# 3. Start agent-sh
npm start
```

### Common Usage Patterns

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

### Common Claude Models

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

### Agent environment configuration

agent-sh can be configured via environment variables:

```bash
# Set the default agent to use
export AGENT_SH_AGENT=pi-acp  # Default is pi-acp
```

**Smart Connection**: agent-sh uses an intelligent connection system where the shell starts immediately and the agent connects in the background. If you send a query before the agent is fully connected, the system automatically waits for connection completion. This provides instant access to the shell while ensuring reliable agent communication.

Many ACP agents also require API keys. Set these before starting agent-sh:

#### pi-acp configuration

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

#### Other agent configurations

Refer to each agent's documentation for their specific environment variable requirements. Common patterns:

```bash
# claude-agent-acp (Anthropic's official Claude agent)
export ANTHROPIC_API_KEY="your-key"

# gemini-cli
export GOOGLE_API_KEY="your-key"
```

**Tip:** Add these to your `~/.zshrc` or `~/.bashrc` for persistent configuration.

### Input modes

| Input | Behavior |
|---|---|
| `ls -la` | Runs in real shell (PTY), output displayed normally |
| `cd src && make` | Real shell — cd, env, aliases all just work |
| `vim file.ts` | Opens vim in the same PTY, no hacks needed |
| `> refactor this fn` | Sends to agent via ACP, streams response inline |
| `> /help` | Shows available slash commands |
| `Ctrl-C` | Standard signal to shell, or cancels active agent response |
| `Ctrl-O` | Expand/collapse truncated diff preview |
| `Ctrl-T` | Toggle thinking/reasoning text display |
| `Escape` | Exit agent input mode (when typing after `>`) |

When you type `>` at the start of a line, agent-sh enters **agent input mode** — the prompt changes to show the agent and model information (e.g., `pi (gpt-4o) ● ❯`) and your text is sent to the agent on Enter. The agent's response streams inline in real-time in a bordered box with markdown rendering and syntax highlighting.

**Agent Info Display**: When entering agent mode, you'll see the current agent name and model (if specified) next to the prompt, followed by a green dot (●) indicating the connection status. For example:
- `pi ● ❯` — pi agent without model specified
- `pi (gpt-4o) ● ❯` — pi agent with gpt-4o model
- `pi (claude-3-5-sonnet-20241022) ● ❯` — pi agent with Claude Sonnet model
- `claude-agent-acp (claude-3-5-sonnet-20241022) ● ❯` — Claude agent with Sonnet model

### Slash commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Start a new agent session |
| `/copy` | Copy last agent response to clipboard |
| `/compact` | Ask agent to summarize the conversation |
| `/quit` | Exit agent-sh |

Slash commands have tab-completion and arrow-key navigation in agent input mode.

### Shell context

The agent automatically receives structured context about your shell session with each query, managed by the ContextManager:

- **Current working directory** — tracked via OSC 7 escape sequences
- **Recent commands and output** — truncated summaries of recent shell commands, agent queries, and tool executions
- **Recall tool** — the agent can run `__shell_recall --search "query"` or `__shell_recall --expand 42` to retrieve full output of any past exchange

This means you can run a failing command, then type `> fix this` and the agent knows exactly what happened. For long outputs, the agent sees a truncated summary and can recall the full content on demand.

## Architecture

agent-sh is an ACP **client**. The agent is a subprocess launched with stdio transport.

### Design philosophy: headless core + pluggable frontends

The core (`createCore()`) is a frontend-agnostic kernel — it wires up the EventBus, ContextManager, and AcpClient with zero knowledge of terminals, PTYs, or rendering. The interactive terminal (Shell + TUI + extensions) is one frontend built on top.

```
createCore() — frontend-agnostic kernel:
  │     EventBus          — typed pub/sub + transform pipelines
  │     ContextManager    — exchange recording, context assembly
  │     AcpClient         — ACP protocol, terminal execution (yolo by default)
  │
index.ts — interactive terminal frontend:
  │     Shell             — PTY lifecycle (delegates to InputHandler + OutputParser)
  │
  ├── Built-in extensions:
  │     tuiRenderer       — markdown rendering, inline diffs, thinking display, spinner
  │     slashCommands     — /help, /clear, /copy, /compact, /quit
  │     fileAutocomplete  — @ file path completion
  │     shellRecall       — __shell_recall terminal interception
  │
  ├── Shared utilities:
  │     palette           — semantic color system (accent, success, warning, error, muted)
  │     diff-renderer     — syntax-highlighted diffs (split/unified/summary)
  │     box-frame         — bordered TUI panels
  │     tool-display      — width-adaptive tool call rendering
  │
  └── User extensions (opt-in, loaded from -e flag / settings.json / extensions dir):
        e.g. interactive-prompts, solarized-theme
```

All components communicate exclusively through typed bus events. AcpClient has no reference to Shell — it emits lifecycle events (`agent:processing-start`, `agent:processing-done`) and Shell subscribes to manage its own state. Input flows the same way: any frontend emits `agent:submit` and the core routes it to the agent.

**The core works without any frontend.** This enables:

- **Library usage** — `import { createCore } from "agent-sh"` to build WebSocket servers, REST APIs, Electron apps, or test harnesses
- **Headless mode** — CI, scripting, embedding — no terminal needed
- **Alternative renderers** — web UI, logging backend, minimal TUI
- **Custom features** — add commands, autocomplete providers, tool interceptors by writing an extension

### We send to the agent

| Method | When |
|---|---|
| `initialize` | Startup: negotiate capabilities |
| `session/new` | Create a conversation session |
| `session/prompt` | User types `> query` — sent with shell context |
| `session/cancel` | User hits Ctrl-C during agent response |

### We handle from the agent

| Method | What we do |
|---|---|
| `terminal/create` | Execute command in an isolated child process |
| `terminal/output` | Return captured output for a terminal ID |
| `terminal/wait_for_exit` | Await command completion, return exit code |
| `terminal/kill` | Send signal to running command |
| `terminal/release` | Cleanup terminal session |
| `fs/read_text_file` | Read file from disk, return content |
| `fs/write_text_file` | Write file to disk |
| `session/request_permission` | Prompt user for y/n/allow-all confirmation |

### We render from the agent

| Update type | What we render |
|---|---|
| `agent_message_chunk` | Real-time streaming markdown with syntax highlighting in a bordered box |
| `agent_thought_chunk` | Thinking spinner (default), or streaming text when toggled on with Ctrl+T |
| `tool_call` | Yellow header showing what the agent is invoking |
| `tool_call_update` | Status indicator (✓ or ✗ with exit code) |
| `file_write` | Inline diff preview in bordered box (Ctrl+O to expand/collapse) |

## Project structure

```
agent-sh/
├── src/
│   ├── index.ts            # Interactive terminal entry point (CLI args, Shell, extensions)
│   ├── core.ts             # createCore() — frontend-agnostic kernel, library entry point
│   ├── event-bus.ts        # Typed EventBus: emit/on, emitPipe, emitPipeAsync
│   ├── shell.ts            # PTY lifecycle + wiring (InputHandler + OutputParser)
│   ├── input-handler.ts    # Keyboard input, agent mode, bus-driven autocomplete
│   ├── output-parser.ts    # OSC parsing, command boundary detection
│   ├── acp-client.ts       # ACP protocol, terminal execution, session management
│   ├── context-manager.ts  # Exchange log, context assembly, recall API
│   ├── extension-loader.ts # Extension loading (-e, settings.json, extensions dir)
│   ├── executor.ts         # Isolated child process execution
│   ├── types.ts            # Shared type definitions
│   ├── utils/
│   │   ├── palette.ts      # Semantic color palette (accent/success/warning/error/muted)
│   │   ├── ansi.ts         # ANSI utility functions (visibleLen, stripAnsi)
│   │   ├── diff.ts         # Line-level LCS diff for file change previews
│   │   ├── diff-renderer.ts# Syntax-highlighted diff display (split/unified/summary)
│   │   ├── box-frame.ts    # Bordered TUI panels (rounded/square/double/heavy)
│   │   ├── tool-display.ts # Width-adaptive tool call/result rendering
│   │   ├── file-watcher.ts # File change detection for agent tool writes
│   │   └── markdown.ts     # Streaming markdown → ANSI renderer
│   └── extensions/
│       ├── tui-renderer.ts       # Terminal rendering (markdown, spinner, tools)
│       ├── slash-commands.ts     # /help, /clear, /copy, /compact, /quit
│       ├── file-autocomplete.ts  # @ file path completion
│       └── shell-recall.ts      # __shell_recall terminal interception
├── examples/
│   └── extensions/
│       ├── interactive-prompts.ts # Example: permission gates (opt-in)
│       └── solarized-theme.ts    # Example: color theme via setPalette()
├── package.json
└── tsconfig.json
```

## Development

```bash
# Run in development mode (no build step)
npm run dev

# Build
npm run build

# Run the built version (uses default agent pi-acp)
npm start

# Quick shortcuts for different agents
npm run pi         # Start with pi-acp
npm run claude     # Start with claude-agent-acp (Anthropic's official Claude agent)

# Debug mode — logs ACP protocol details to stderr
DEBUG=1 npm start

# Test with specific agent
npm run dev -- --agent pi-acp
```

## How it works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config — oh-my-zsh, p10k, aliases, plugins, PATH) and sets up raw stdin passthrough
2. It launches the specified ACP agent as a subprocess with stdio transport
3. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
4. **Smart connection**: The agent connects asynchronously in the background while the shell starts immediately
5. **Auto-wait**: If you send a query before the agent is fully connected, the system automatically waits for connection completion
6. When you type `>` at the start of a line, agent-sh intercepts and enters agent input mode
7. On Enter, the query (plus shell context) is sent to the agent via `session/prompt`
8. The agent's streaming response renders inline in a bordered markdown box with real-time output
9. If the agent needs to run commands, it calls `terminal/create` and agent-sh executes them in isolated child processes, streaming output back
10. When the agent finishes, normal shell operation resumes

### EventBus

All communication between components flows through a typed EventBus. Components emit events (shell commands, agent responses, tool calls) and extensions subscribe to events they care about. The bus supports three modes:

- **emit/on** — fire-and-forget notifications (e.g., `agent:response-chunk`)
- **emitPipe/onPipe** — synchronous transform chains (e.g., `autocomplete:request` where extensions append completion items)
- **emitPipeAsync/onPipeAsync** — async transform chains (e.g., `permission:request` where extensions prompt the user and return a decision)

### Writing extensions

An extension is a module that exports a default (or named `activate`) function. It receives an `ExtensionContext` with access to all core services:

```typescript
// my-extension.js
export default function activate(ctx) {
  // Listen to agent events
  ctx.bus.on("agent:response-done", (e) => {
    console.log(`Agent responded with ${e.response.length} chars`);
  });

  // Add a slash command
  ctx.bus.on("command:execute", (e) => {
    if (e.name === "/greet") {
      ctx.bus.emit("ui:info", { message: "Hello from my extension!" });
    }
  });
  ctx.bus.onPipe("autocomplete:request", (payload) => {
    if (!payload.buffer.startsWith("/g")) return payload;
    return { ...payload, items: [...payload.items, { name: "/greet", description: "Say hello" }] };
  });

  // Intercept terminal commands
  ctx.bus.onPipe("agent:terminal-intercept", (payload) => {
    if (payload.command !== "my-tool") return payload;
    return { ...payload, intercepted: true, output: "custom output" };
  });
}
```

The `ExtensionContext` provides:

| Property | Type | Description |
|---|---|---|
| `bus` | `EventBus` | Subscribe to events, emit events, register pipe handlers |
| `contextManager` | `ContextManager` | Access exchange history, cwd, search, expand |
| `getAcpClient` | `() => AcpClient` | Lazy getter for the agent client |
| `quit` | `() => void` | Exit agent-sh |
| `setPalette` | `(overrides: Partial<ColorPalette>) => void` | Override color palette slots for theming |

### Yolo mode

By default, agent-sh runs in **yolo mode** — all tool calls and file writes are auto-approved. This matches pi's design philosophy where the agent operates freely unless you explicitly add permission gates.

To add permission prompts, load the example extension:
```bash
# One-off
npm start -- -e ./examples/extensions/interactive-prompts.ts

# Permanent: copy to your extensions dir
cp examples/extensions/interactive-prompts.ts ~/.agent-sh/extensions/

# Or add to settings.json
echo '{ "extensions": ["./examples/extensions/interactive-prompts.ts"] }' > ~/.agent-sh/settings.json
```

### Theming

agent-sh uses a semantic color palette with ~10 base roles (`accent`, `success`, `warning`, `error`, `muted`, plus background variants and style modifiers). Extensions can override any slot via `setPalette()`:

```typescript
// solarized-theme.ts
export default function activate({ setPalette }) {
  setPalette({
    accent:  "\x1b[38;2;38;139;210m",   // solarized blue
    success: "\x1b[38;2;133;153;0m",    // solarized green
    warning: "\x1b[38;2;181;137;0m",    // solarized yellow
    error:   "\x1b[38;2;220;50;47m",    // solarized red
    muted:   "\x1b[38;2;88;110;117m",   // solarized base01
  });
}
```

Load a theme like any other extension:
```bash
npm start -- -e ./examples/extensions/solarized-theme.ts
```

A complete example is included at `examples/extensions/solarized-theme.ts`.

### Loading extensions

Extensions are loaded from three sources (in order, deduplicated):

**1. CLI flag (`-e` / `--extensions`)** — npm packages or file paths, repeatable:
```bash
npm start -- -e my-ext-package -e ./local-ext.ts
npm start -- -e my-ext-package,another-package   # comma-separated also works
```

**2. Settings file** — `~/.agent-sh/settings.json`:
```json
{
  "extensions": [
    "my-published-extension",
    "/absolute/path/to/ext.ts",
    "./relative/path/to/ext.js"
  ]
}
```

**3. Extensions directory** — files and directories in `~/.agent-sh/extensions/`:
```bash
~/.agent-sh/extensions/
├── my-extension.ts          # loaded directly
├── another.js               # JS works too
└── complex-extension/       # directory with index file
    ├── index.ts             # entry point (auto-detected)
    └── helpers.ts           # supporting modules
```

Extensions can be written in **TypeScript or JavaScript** — `.ts`, `.tsx`, `.mts`, `.js`, `.mjs` are all supported. TS extensions are transpiled at runtime via tsx.

Bare names (e.g. `my-ext-package`) resolve as **npm packages** via Node's standard module resolution. Install them globally or locally and reference by name.

Errors in extension loading are non-fatal — a `ui:error` is emitted and the next extension continues loading.

### Using as a library

The core can be imported directly for building custom frontends — no terminal required:

```typescript
import { createCore } from "agent-sh";

const core = createCore({ agentCommand: "pi-acp" });

// Subscribe to events
core.bus.on("agent:response-chunk", ({ text }) => process.stdout.write(text));
core.bus.on("agent:processing-done", () => console.log("\n[done]"));

// Handle permissions (auto-approve, or wire to your own UI)
core.bus.onPipeAsync("permission:request", async (p) => {
  return { ...p, decision: { approved: true } };
});

// Connect and send a query
await core.start();
core.bus.emit("agent:submit", { query: "explain this codebase" });
```

This works for WebSocket servers, REST APIs, Electron apps, test harnesses, or any environment where you want agent-sh's context management and ACP integration without the interactive terminal.

## Troubleshooting

### Agent connection issues

**Problem**: "Agent not connected. Please wait a moment and try again."

**Solutions**:
1. **Check agent installation**:
   ```bash
   which pi-acp
   which claude-agent-acp
   ```

2. **Verify ACP compatibility**:
   ```bash
   # Test if agent supports ACP protocol
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test","version":"1.0.0"},"clientCapabilities":{"terminal":true,"fs":{"readTextFile":true,"writeTextFile":true}}}}' | pi-acp
   ```

3. **Install missing agents**:
   ```bash
   npm install -g pi-acp
   npm install -g @agentclientprotocol/claude-agent-acp
   ```

4. **Check environment variables**:
   ```bash
   echo $ANTHROPIC_API_KEY
   echo $OPENAI_API_KEY
   echo $GEMINI_API_KEY
   ```

### Common errors

**Error**: "claude: command not found"
- **Cause**: Trying to use `claude` CLI tool which doesn't support ACP
- **Solution**: Use `claude-agent-acp` or `pi-acp` instead

**Error**: "API key not found"
- **Cause**: Missing required API key environment variable
- **Solution**: Set the appropriate API key (e.g., `export ANTHROPIC_API_KEY="your-key"`)

**Error**: "Invalid model name"
- **Cause**: Using incorrect model name
- **Solution**: Use valid model names like `claude-3-5-sonnet-20241022` or `gpt-4o`

**Error**: "Agent process exited with code X"
- **Cause**: Agent crashed or failed to start
- **Solution**: Check agent installation and API key validity

### Debug mode

Enable debug mode to see detailed ACP protocol information:
```bash
DEBUG=1 npm start -- --agent pi-acp
```

### Getting help

If you encounter issues:
1. Check the [ACP Protocol Documentation](https://agentclientprotocol.com/)
2. Verify agent installation: `pi-acp --version` or `claude-agent-acp --version`
3. Test with different agents to isolate the problem
4. Check GitHub issues for known problems

## License

MIT
