# agent-sh

An agent that lives in a shell — not a shell that lives in an agent.

[![npm version](https://img.shields.io/npm/v/agent-sh.svg)](https://www.npmjs.com/package/agent-sh)
[![license](https://img.shields.io/npm/l/agent-sh.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

Most AI terminal tools get this backwards: the LLM drives the experience and the shell is bolted on as an afterthought. No real PTY, no job control, no vim, fragile `cd` tracking. The agent is the main character and your terminal is a prop.

agent-sh flips this. It's your shell first — full PTY, your rc config, your aliases, everything just works. But type `>` at the start of a line, and you're talking to an agent that has full context of what you've been doing.

```
~ $ ls -la                          # real shell command
~ $ cd ../tests && npm test          # real cd, env, aliases — all just work
~ $ vim file.ts                      # opens vim in the same PTY
~ $ > explain the last error          # agent investigates using its own tools
~ $ > deploy to staging              # agent runs it in your live shell
```

## Quick Start

```bash
npm install -g agent-sh
agent-sh
```

Tip: add an alias to your shell config for quick access:

```bash
alias ash="agent-sh"
```

Set `OPENAI_API_KEY` in your environment (or configure providers in `~/.agent-sh/settings.json`). Works with any OpenAI-compatible API — see the [Usage Guide](docs/usage.md) for provider examples (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio, vLLM).

Requires Node.js 18+.

## Key Features

**Real terminal, zero compromise.** Full PTY with your shell config, aliases, and environment. Shell starts instantly — the agent connects asynchronously in the background.

**One entry point, smart tool selection.** Type `>` and agent-sh figures out how to help. Scratchpad tools (`bash`, `read_file`, `grep`, `glob`) for investigation. Extensions add capabilities like running commands in your live shell. No modes to pick — the agent reasons about which tools to use based on your intent.

**Context that just works.** Every query includes your cwd, recent commands, and their output. Run a failing test, type `> fix this`, and agent-sh knows exactly what happened. Context management works like shell history — continuous, persistent across restarts, no sessions to manage. See [Context Management](docs/context-management.md).

**Any LLM, any backend.** agent-sh works with any OpenAI-compatible API out of the box. Define multiple providers in settings and cycle between models at runtime with Shift+Tab. Or swap in a completely different agent — [Claude Code](examples/extensions/claude-code-bridge/) and [pi](examples/extensions/pi-bridge/) run as drop-in backend extensions.

**Extensible by design.** The entire system is built on a typed event bus. Extensions can add custom input modes, content transforms (render LaTeX as images, Mermaid as diagrams), themes, slash commands, or replace the agent backend entirely. The built-in TUI renderer is itself just an extension.

**Embeddable as a library.** The core is a headless kernel — `import { createCore } from "agent-sh"` to build WebSocket servers, REST APIs, Electron apps, or test harnesses. No terminal required.

## Configuration

Configure via `~/.agent-sh/settings.json`. See the [Usage Guide](docs/usage.md#configuration) for the full settings reference.

## Documentation

- [Usage Guide](docs/usage.md) — providers, models, configuration
- [Internal Agent](docs/agent.md) — tools, context, streaming
- [Context Management](docs/context-management.md) — three-tier history, token budget
- [Architecture](docs/architecture.md) — design philosophy, component overview
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
