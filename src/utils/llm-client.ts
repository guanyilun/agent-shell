/**
 * Thin, stateless wrapper around the OpenAI SDK.
 * No agent-sh knowledge — just a configured client.
 *
 * Used by both AgentLoop (full tool loop) and fast-path features
 * (command suggestions, completions).
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";

export type { ChatCompletionMessageParam, ChatCompletionTool };

export interface LlmClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export class LlmClient {
  private client: OpenAI;
  public model: string;

  constructor(private config: LlmClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
  }

  /** Swap the underlying client config at runtime (e.g. provider switch). */
  reconfigure(newConfig: LlmClientConfig): void {
    this.config = newConfig;
    this.client = new OpenAI({
      apiKey: newConfig.apiKey,
      baseURL: newConfig.baseURL,
    });
    this.model = newConfig.model;
  }

  /**
   * Create a streaming chat completion.
   * Returns an async iterable of chunks.
   */
  stream(opts: {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    model?: string;
    max_tokens?: number;
    signal?: AbortSignal;
  }) {
    return this.client.chat.completions.create(
      {
        model: opts.model ?? this.model,
        messages: opts.messages,
        tools: opts.tools?.length ? opts.tools : undefined,
        max_tokens: opts.max_tokens ?? 8192,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: opts.signal },
    );
  }

  /**
   * Single-shot completion (no streaming) — for fast-path features.
   * Returns the text content of the first choice.
   */
  async complete(opts: {
    messages: ChatCompletionMessageParam[];
    model?: string;
    max_tokens?: number;
  }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: opts.model ?? this.model,
      messages: opts.messages,
      max_tokens: opts.max_tokens ?? 1024,
    });
    return response.choices[0]?.message?.content ?? "";
  }
}
