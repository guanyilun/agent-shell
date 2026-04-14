/**
 * Web Access extension — web search & content extraction for agent-sh.
 *
 * Provides two tools:
 *   - web_search:  Search the web via Exa MCP (free, no API key)
 *   - web_fetch:   Extract page content as clean markdown
 *                   Fallback chain: Z.AI reader → Jina Reader → direct fetch
 *
 * Optional: ZAI_API_KEY environment variable (for Z.AI reader, best quality)
 *
 * Optional configuration (~/.agent-sh/settings.json):
 *   {
 *     "web-access": {
 *       "timeout": 30000,
 *       "searchNumResults": 5
 *     }
 *   }
 *
 * Inspired by: https://github.com/nicobailon/pi-web-access
 */
import type { ExtensionContext } from "agent-sh/types";

// ── Constants ────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

const ZAI_BASE = "https://api.z.ai";
const ZAI_READER_PATH = "/api/mcp/web_reader/mcp";

const JINA_READER_URL = "https://r.jina.ai";

// ── Exa MCP search (free, no key, no session) ───────────────────────

async function exaSearch(
  query: string,
  numResults: number,
  timeout: number,
): Promise<string> {
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          numResults,
          type: "auto",
          livecrawl: "fallback",
          contextMaxCharacters: 3000,
        },
      },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    throw new Error(`Exa MCP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const body = await res.text();

  // Parse SSE or JSON response
  let parsed: any = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(line.charAt(5) === " " ? 6 : 5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload);
      if (candidate?.result || candidate?.error) { parsed = candidate; break; }
    } catch { /* skip */ }
  }

  if (!parsed) {
    try { parsed = JSON.parse(body); } catch { /* skip */ }
  }

  if (!parsed) throw new Error("Exa MCP returned empty response");
  if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
  if (parsed.result?.isError) {
    const msg = parsed.result.content?.find((c: any) => c.type === "text")?.text;
    throw new Error(msg ?? "Exa MCP returned an error");
  }

  const text = parsed.result?.content?.find(
    (c: any) => c.type === "text" && c.text?.trim(),
  )?.text;

  if (!text) throw new Error("Exa MCP returned empty content");
  return text;
}

// ── Z.AI MCP reader (requires API key + session) ────────────────────

let zaiRpcId = 0;
const zaiSessionId = { current: "" };

async function zaiMcpPost(
  apiKey: string,
  body: Record<string, unknown>,
  timeout: number,
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${apiKey}`,
  };
  if (zaiSessionId.current) headers["mcp-session-id"] = zaiSessionId.current;

  const res = await fetch(`${ZAI_BASE}${ZAI_READER_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) throw new Error(`Z.AI MCP ${res.status}`);

  const sid = res.headers.get("mcp-session-id");
  if (sid) zaiSessionId.current = sid;

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(line.charAt(5) === " " ? 6 : 5);
      if (!payload) continue;
      const parsed = JSON.parse(payload);
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.result;
    }
    throw new Error("No data in Z.AI SSE response");
  }

  const json = await res.json();
  const response = Array.isArray(json) ? json[0] : json;
  if (response?.error) throw new Error(response.error.message);
  return response?.result;
}

async function zaiRead(apiKey: string, url: string, timeout: number): Promise<string> {
  // Initialize session if needed
  if (!zaiSessionId.current) {
    await zaiMcpPost(apiKey, {
      jsonrpc: "2.0", id: ++zaiRpcId, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "ash-web-access", version: "1.0.0" },
      },
    }, timeout);
    await zaiMcpPost(apiKey, {
      jsonrpc: "2.0", method: "notifications/initialized",
    }, timeout);
  }

  const result = await zaiMcpPost(apiKey, {
    jsonrpc: "2.0", id: ++zaiRpcId, method: "tools/call",
    params: { name: "webReader", arguments: { url } },
  }, timeout);

  // Unwrap double-encoded JSON response
  const textBlock = result?.content?.find((c: any) => c.type === "text" && c.text);
  if (!textBlock) return JSON.stringify(result, null, 2);

  let data: any;
  try {
    data = JSON.parse(textBlock.text);
    if (typeof data === "string") data = JSON.parse(data);
  } catch {
    return textBlock.text;
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const title = data.title ? `# ${data.title}\n\n` : "";
    const source = data.url ? `**Source:** ${data.url}\n\n` : "";
    const body = data.content ?? data.markdown ?? data.text ?? JSON.stringify(data, null, 2);
    return `${title}${source}${body}`;
  }

  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

// ── Jina Reader (free, no key) ───────────────────────────────────────

async function jinaRead(url: string, timeout: number): Promise<string> {
  const res = await fetch(`${JINA_READER_URL}/${url}`, {
    headers: { Accept: "text/markdown", "X-Return-Format": "markdown" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Jina Reader ${res.status}`);
  return res.text();
}

// ── Direct fetch (last resort) ───────────────────────────────────────

async function directFetch(url: string, timeout: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return JSON.stringify(await res.json(), null, 2);
  return res.text();
}

// ── Extension entry point ────────────────────────────────────────────

export default function activate(ctx: ExtensionContext) {
  const apiKey = process.env.ZAI_API_KEY ?? "";

  const config = ctx.getExtensionSettings("web-access", {
    timeout: 30000,
    searchNumResults: 5,
  });

  const timeout = config.timeout ?? 30000;
  const numResults = config.searchNumResults ?? 5;

  // ── Tool: web_search (Exa MCP, free) ────────────────────────────

  ctx.registerTool({
    name: "web_search",
    displayName: "Web Search",
    description:
      "Search the web and return results with titles, URLs, and content snippets. " +
      "Free, no API key required. Powered by Exa.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        numResults: {
          type: "number",
          description: `Number of results (default: ${numResults}, max: 10)`,
        },
      },
      required: ["query"],
    },
    async execute(args: { query: string; numResults?: number }) {
      const n = Math.min(args.numResults ?? numResults, 10);
      try {
        const results = await exaSearch(args.query, n, timeout);
        return { content: results, exitCode: 0, isError: false };
      } catch (err: any) {
        return { content: `Search failed: ${err.message}`, exitCode: 1, isError: true };
      }
    },
    formatCall(args: { query: string }) {
      return `Searching: "${args.query}"`;
    },
  });

  // ── Tool: web_fetch ─────────────────────────────────────────────

  ctx.registerTool({
    name: "web_fetch",
    displayName: "Web Fetch",
    description:
      "Fetch a URL and extract its content as clean markdown. " +
      "Handles web pages, articles, and documentation. " +
      "Uses Z.AI reader (best quality), Jina Reader, or direct fetch as fallback.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        raw: {
          type: "boolean",
          description:
            "If true, fetch raw content directly (useful for JSON APIs, raw text files)",
        },
      },
      required: ["url"],
    },
    async execute(args: { url: string; raw?: boolean }) {
      if (args.raw) {
        try {
          const content = await directFetch(args.url, timeout);
          return { content, exitCode: 0, isError: false };
        } catch (err: any) {
          return { content: `Fetch failed: ${err.message}`, exitCode: 1, isError: true };
        }
      }

      // Fallback chain: Z.AI reader → Jina Reader → direct fetch
      if (apiKey) {
        try {
          const content = await zaiRead(apiKey, args.url, timeout);
          return { content, exitCode: 0, isError: false };
        } catch { /* fall through */ }
      }

      try {
        const content = await jinaRead(args.url, timeout);
        return { content, exitCode: 0, isError: false };
      } catch { /* fall through */ }

      try {
        const content = await directFetch(args.url, timeout);
        return { content, exitCode: 0, isError: false };
      } catch (err: any) {
        return { content: `All fetch methods failed: ${err.message}`, exitCode: 1, isError: true };
      }
    },
    formatCall(args: { url: string }) {
      return `Fetching: ${args.url}`;
    },
  });
}
