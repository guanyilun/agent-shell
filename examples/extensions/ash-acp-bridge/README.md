# ash-acp-bridge

ACP (Agent Client Protocol) server that wraps agent-sh's headless core, allowing any ACP-compatible client to use ash as a backend.

## Setup

```bash
cd ash-acp-bridge
npm install
npm run build    # or use `npx tsx src/index.ts` for dev
```

## Usage

```bash
ash-acp-bridge                          # use ~/.agent-sh/settings.json defaults
ash-acp-bridge --model gpt-4o           # override model
ash-acp-bridge --provider anthropic     # override provider
```

## How it works

```
ACP client
    ↕ JSON-RPC over stdin/stdout (ACP)
ash-acp-bridge
    ↕ EventBus
agent-sh core (headless)
    ↕ OpenAI-compatible API
LLM provider
```

The adapter translates between ACP methods and agent-sh's event bus:

- `initialize` → return capabilities
- `session/new` → create core, set cwd
- `session/prompt` → `agent:submit` event
- `session/update` notifications ← `agent:response-chunk`, `agent:tool-started`, etc.
- `session/request_permission` ↔ `permission:request` async pipe
