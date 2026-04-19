# agent-sh Documentation

Start with **Usage** to get running, then **Architecture** for the mental model. Everything else builds on those two.

## Guides

1. [Usage Guide](usage.md) — install, run, configure providers and models
2. [Architecture](architecture.md) — pure kernel + extensions, the shell ↔ agent boundary, project structure
3. [The Built-in Agent: ash](agent.md) — how the default backend works: query flow, tools, system prompt, model switching
4. [Context Management](context-management.md) — shell-output spill, three-tier conversation compaction, recall APIs
5. [Extensions](extensions.md) — event bus, content transforms, custom agent backends, theming
6. [TUI Composition](tui-composition.md) — compositor, render surfaces, stream routing
7. [Library Usage](library.md) — embedding agent-sh in your own apps
8. [Troubleshooting](troubleshooting.md) — common errors and debug mode
