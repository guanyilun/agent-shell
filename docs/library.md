# Using agent-sh as a Library

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

See [Architecture](architecture.md) for details on the core design and EventBus.
