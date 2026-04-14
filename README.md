# agent-sh

[![npm version](https://img.shields.io/npm/v/agent-sh.svg)](https://www.npmjs.com/package/agent-sh)
[![license](https://img.shields.io/npm/l/agent-sh.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

Not a shell that lives in an agent — an agent that lives in a shell.

I live in a terminal. I don't want an agent that can run shell commands when it needs to — I want my shell, with an agent I can reach for when *I* need to. Most AI tools get this backwards: the LLM drives the experience and the shell is bolted on as an afterthought. No real PTY, no job control, no vim, fragile `cd` tracking. The agent is the main character and your terminal is a prop.

agent-sh flips this. It's your shell first — full PTY, your rc config, your aliases, everything just works. But type `>` at the start of a line, and you're talking to an agent that has full context of what you've been doing.

```
⚡ src $ ls -la                          # real shell command
⚡ src $ cd ../tests && npm test          # real cd, env, aliases — all just work
⚡ src $ vim file.ts                      # opens vim in the same PTY
⚡ src $ > explain the last error          # agent investigates using its own tools
⚡ src $ > deploy to staging              # agent runs it in your live shell
```

## Key Features

**Real terminal, zero compromise.** Full PTY with your shell config, aliases, and environment. Shell starts instantly — the agent connects asynchronously in the background.

**Context-aware agent.** Every query includes your cwd, recent commands, and their output. Run a failing test, type `> fix this`, and the agent knows exactly what happened. It has built-in tools for file read/write/edit, bash, grep, glob — no external setup needed. Context management works like shell history — continuous, persistent across restarts, no sessions to manage. See [Context Management](docs/context-management.md).

**Agent decides how to help.** One entry point (`>`), three tool categories. The agent uses scratchpad tools to investigate, `display` to show you output, and `user_shell` for commands with lasting effects. No need to pick a mode — the agent reasons about which tools to use based on your intent.

**Any LLM, any backend.** Works with any OpenAI-compatible API out of the box. Define multiple providers in settings and cycle between models at runtime with Shift+Tab. Or swap in a completely different agent — [Claude Code](examples/extensions/claude-code-bridge/) and [pi](examples/extensions/pi-bridge/) run as drop-in backend extensions.

**Extensible by design.** The entire system is built on a typed event bus. Extensions can add custom input modes, content transforms (render LaTeX as images, Mermaid as diagrams), themes, slash commands, or replace the agent backend entirely. The built-in TUI renderer is itself just an extension — nothing is special.

**Embeddable as a library.** The core is a headless kernel — `import { createCore } from "agent-sh"` to build WebSocket servers, REST APIs, Electron apps, or test harnesses. No terminal required.

## Quick Start

```bash
npm install -g agent-sh
agent-sh
```

Set `OPENAI_API_KEY` in your environment (or configure providers in `~/.agent-sh/settings.json`). Works with any OpenAI-compatible API — see the [Usage Guide](docs/usage.md) for provider examples (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio, vLLM).

Requires Node.js 18+.

## Agent Mode

Type `>` at the start of a line to talk to the agent. The agent decides how to help:

- **Scratchpad tools** (`bash`, `read_file`, `grep`, `glob`, etc.) — for investigation. Output goes to the agent, not your terminal.
- **`display`** — shows output in your terminal (e.g. `cat`, `git log`). You see it; the agent doesn't process it.
- **`user_shell`** — runs commands with lasting effects (`cd`, `npm install`, etc.) in your live shell.

Everything else works as a normal shell — commands go straight to the PTY. Input modes are extensible — see [Extensions: Custom Input Modes](docs/extensions.md#custom-input-modes).

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/model [name]` | Cycle to the next model, or switch to a specific one |
| `/backend [name]` | List backends, or switch to a named backend |
| `/compact` | Compact conversation (free up context space) |
| `/context` | Show context budget usage |
| `/thinking [level]` | Set reasoning effort (off, low, medium, high) |

## Configuration

Configure via `~/.agent-sh/settings.json`. See the [Usage Guide](docs/usage.md#configuration) for the full settings reference (providers, models, extensions, skills, and more).

## Documentation

- [Usage Guide](docs/usage.md) — providers, models, configuration, provider profiles
- [Internal Agent](docs/agent.md) — how the agent loop works: tools, context, streaming
- [Context Management](docs/context-management.md) — three-tier history, token budget, design philosophy
- [Architecture](docs/architecture.md) — design philosophy, component overview, project structure
- [Extensions](docs/extensions.md) — event bus, content transforms, custom backends, theming
- [TUI Composition](docs/tui-composition.md) — compositor, render surfaces, stream routing
- [Library Usage](docs/library.md) — embedding agent-sh in your own apps
- [Troubleshooting](docs/troubleshooting.md) — common errors and debug mode

## Development

```bash
git clone https://github.com/guanyilun/agent-sh.git
cd agent-sh
npm install
npm run build
npm start
```

## License

MIT
