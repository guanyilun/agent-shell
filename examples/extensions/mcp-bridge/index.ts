/**
 * MCP Bridge — connects external MCP servers to agent-sh.
 *
 * Spawns MCP servers as child processes, discovers their tools,
 * and registers each tool as an agent-sh ToolDefinition.
 *
 * Configure in ~/.agent-sh/settings.json:
 *
 *   {
 *     "extensions": ["./path/to/mcp-bridge"],
 *     "mcp-bridge": {
 *       "servers": {
 *         "vision": {
 *           "command": "npx",
 *           "args": ["-y", "@z_ai/mcp-server"],
 *           "env": {
 *             "Z_AI_API_KEY": "your-key",
 *             "Z_AI_MODE": "ZAI"
 *           }
 *         }
 *       }
 *     }
 *   }
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpBridgeSettings {
  servers: Record<string, McpServerConfig>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
}

export default async function activate(ctx: any): Promise<void> {
  const { bus } = ctx;

  const settings = ctx.getExtensionSettings("mcp-bridge", {
    servers: {},
  }) as McpBridgeSettings;

  const serverEntries = Object.entries(settings.servers);
  if (serverEntries.length === 0) return;

  const connected: ConnectedServer[] = [];

  for (const [name, config] of serverEntries) {
    try {
      const server = await connectServer(name, config, ctx);
      connected.push(server);
    } catch (err: any) {
      bus.emit("ui:info", {
        message: `mcp-bridge: failed to connect "${name}": ${err.message}`,
      });
    }
  }

  // Clean up on exit
  bus.on("app:quit", () => {
    for (const server of connected) {
      try {
        server.transport.close();
      } catch {}
    }
  });
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  ctx: any,
): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env } as Record<string, string>,
  });

  const client = new Client({ name: `ash-${name}`, version: "0.1.0" });
  await client.connect(transport);

  // Discover and register tools
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const toolName = `mcp_${name}_${tool.name}`;
    ctx.registerTool({
      name: toolName,
      displayName: tool.name,
      description: `[${name}] ${tool.description ?? ""}`,
      input_schema: tool.inputSchema as Record<string, unknown>,

      async execute(args: Record<string, unknown>) {
        try {
          const result = await client.callTool({
            name: tool.name,
            arguments: args,
          });

          const text = (result.content as any[])
            .map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "image") return `[image: ${c.mimeType}]`;
              return JSON.stringify(c);
            })
            .join("\n");

          return {
            content: text,
            exitCode: result.isError ? 1 : 0,
            isError: !!result.isError,
          };
        } catch (err: any) {
          return {
            content: `MCP error: ${err.message}`,
            exitCode: 1,
            isError: true,
          };
        }
      },

      getDisplayInfo() {
        return { kind: "execute" as const };
      },

      formatCall(args: Record<string, unknown>) {
        // Show a compact summary of the args
        const keys = Object.keys(args);
        if (keys.length === 0) return tool.name;
        const first = args[keys[0]];
        const preview =
          typeof first === "string"
            ? first.slice(0, 60) + (first.length > 60 ? "…" : "")
            : JSON.stringify(first).slice(0, 60);
        return `${tool.name}: ${preview}`;
      },
    });
  }

  ctx.bus.emit("ui:info", {
    message: `mcp-bridge: "${name}" connected (${tools.length} tools)`,
  });

  return { name, client, transport };
}
