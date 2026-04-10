/**
 * Stream transform helpers for content pipeline extensions.
 *
 * Handles the boilerplate of buffering across chunk boundaries,
 * pattern matching, and flush-on-done coordination.
 */
import type { EventBus, ContentBlock } from "../event-bus.js";

export interface BlockTransformOptions {
  /** Opening delimiter (e.g. "$$") */
  open: string;
  /** Closing delimiter (e.g. "$$") */
  close: string;
  /**
   * Transform the content between delimiters.
   * Return a ContentBlock (text, image, or raw) or null to keep original.
   */
  transform: (content: string) => ContentBlock | ContentBlock[] | null;
}

/**
 * Register a delimiter-based block transform on the content pipeline.
 *
 * Automatically handles:
 *   - Buffering across chunk boundaries
 *   - Safe boundary detection (only emits text outside open delimiters)
 *   - Flush on response-done
 *
 * Example:
 *   createBlockTransform(bus, {
 *     open: "$$",
 *     close: "$$",
 *     transform(latex) {
 *       const png = renderLatex(latex);
 *       return png ? { type: "image", data: png } : null;
 *     },
 *   });
 */
export function createBlockTransform(
  bus: EventBus,
  opts: BlockTransformOptions,
): void {
  let buffer = "";

  bus.onPipe("agent:response-chunk", (e) => {
    // Process text from e.text and from text blocks in e.blocks
    const outBlocks: ContentBlock[] = [];

    if (e.blocks) {
      for (const block of e.blocks) {
        if (block.type === "text") {
          // Run delimiter detection on text blocks
          buffer += block.text;
          const { blocks: parsed, pending } = processBuffer(buffer, opts);
          buffer = pending;
          outBlocks.push(...parsed);
        } else {
          // Pass through non-text blocks unchanged
          outBlocks.push(block);
        }
      }
    }

    // Also process any raw text not yet in blocks
    if (e.text) {
      buffer += e.text;
      const { blocks: parsed, pending } = processBuffer(buffer, opts);
      buffer = pending;
      outBlocks.push(...parsed);
    }

    return { ...e, text: "", blocks: outBlocks };
  });

  bus.onPipe("agent:response-done", (e) => {
    if (buffer) {
      // Unclosed pattern — flush as text
      bus.emitTransform("agent:response-chunk", {
        text: buffer,
        blocks: [{ type: "text", text: buffer }],
      });
      buffer = "";
    }
    return e;
  });
}

// ── Fenced block transform ────────────────────────────────────────

export interface FencedBlockTransformOptions {
  /** Regex matching the opening fence line. Captures are passed to transform. */
  open: RegExp;
  /** Regex matching the closing fence line. */
  close: RegExp;
  /**
   * Transform a complete fenced block.
   * Receives the opening fence match and the content between fences.
   * Return ContentBlock(s), or null to produce a default code-block.
   */
  transform: (openMatch: RegExpMatchArray, content: string) => ContentBlock | ContentBlock[] | null;
}

/**
 * Register a line-delimited fenced block transform on the content pipeline.
 *
 * Detects patterns like ```lang\n...\n``` in the streaming text,
 * buffers the content line-by-line, and produces ContentBlocks when
 * the closing fence arrives.
 *
 * Example:
 *   createFencedBlockTransform(bus, {
 *     open: /^```(\w*)\s*$/,
 *     close: /^```\s*$/,
 *     transform(match, content) {
 *       return { type: "code-block", language: match[1] || "", code: content };
 *     },
 *   });
 */
export interface FencedBlockTransformHandle {
  /** Flush any buffered text (e.g. before tool calls, to preserve interleaving). */
  flush(): void;
}

export function createFencedBlockTransform(
  bus: EventBus,
  opts: FencedBlockTransformOptions,
): FencedBlockTransformHandle {
  let buffer = "";
  let inFence = false;
  let fenceMatch: RegExpMatchArray | null = null;
  let fenceLines: string[] = [];
  let flushing = false;

  bus.onPipe("agent:response-chunk", (e) => {
    if (flushing) return e; // pass through during flush to avoid re-buffering
    // Collect text from blocks or raw text
    let incoming = "";
    if (e.blocks) {
      // Process text blocks, pass through non-text blocks
      const passthrough: ContentBlock[] = [];
      for (const block of e.blocks) {
        if (block.type === "text") {
          incoming += block.text;
        } else {
          passthrough.push(block);
        }
      }
      const { blocks, pending } = processFencedBuffer(buffer + incoming, opts, inFence, fenceMatch, fenceLines);
      buffer = pending.text;
      inFence = pending.inFence;
      fenceMatch = pending.fenceMatch;
      fenceLines = pending.fenceLines;
      return { ...e, text: "", blocks: [...passthrough, ...blocks] };
    }

    // No blocks yet — work with raw text
    incoming = buffer + e.text;
    const { blocks, pending } = processFencedBuffer(incoming, opts, inFence, fenceMatch, fenceLines);
    buffer = pending.text;
    inFence = pending.inFence;
    fenceMatch = pending.fenceMatch;
    fenceLines = pending.fenceLines;
    const existing = e.blocks ?? [];
    return { ...e, text: "", blocks: [...existing, ...blocks] };
  });

  function flushBuffer(): void {
    if (!buffer && !inFence) return;
    let remaining = buffer;
    if (inFence) {
      remaining = (fenceMatch?.[0] ?? "") + "\n" + fenceLines.join("\n") + (remaining ? "\n" + remaining : "");
      inFence = false;
      fenceMatch = null;
      fenceLines = [];
    }
    buffer = "";
    if (remaining) {
      flushing = true;
      bus.emitTransform("agent:response-chunk", {
        text: "",
        blocks: [{ type: "text", text: remaining }],
      });
      flushing = false;
    }
  }

  bus.onPipe("agent:response-done", (e) => {
    flushBuffer();
    return e;
  });

  return { flush: flushBuffer };
}

interface FencedPendingState {
  text: string;
  inFence: boolean;
  fenceMatch: RegExpMatchArray | null;
  fenceLines: string[];
}

function processFencedBuffer(
  text: string,
  opts: FencedBlockTransformOptions,
  inFence: boolean,
  fenceMatch: RegExpMatchArray | null,
  fenceLines: string[],
): { blocks: ContentBlock[]; pending: FencedPendingState } {
  const blocks: ContentBlock[] = [];
  const lines = text.split("\n");
  // Last element might be an incomplete line — hold it back
  const incompleteLine = lines.pop()!;

  let textAccum = ""; // accumulate non-fence text as one block

  for (const line of lines) {
    if (inFence) {
      // Check for closing fence
      if (opts.close.test(line)) {
        const content = fenceLines.join("\n");
        const result = opts.transform(fenceMatch!, content);
        if (result === null) {
          const lang = fenceMatch?.[1] ?? "";
          blocks.push({ type: "code-block", language: lang, code: content });
        } else if (Array.isArray(result)) {
          blocks.push(...result);
        } else {
          blocks.push(result);
        }
        inFence = false;
        fenceMatch = null;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
    } else {
      // Check for opening fence
      const match = line.match(opts.open);
      if (match) {
        // Flush accumulated text before the fence
        if (textAccum) {
          blocks.push({ type: "text", text: textAccum });
          textAccum = "";
        }
        inFence = true;
        fenceMatch = match;
        fenceLines = [];
      } else {
        // Accumulate non-fence text (keep contiguous for downstream transforms)
        textAccum += line + "\n";
      }
    }
  }

  // Flush remaining accumulated text
  if (textAccum) {
    blocks.push({ type: "text", text: textAccum });
  }

  return {
    blocks,
    pending: {
      text: incompleteLine,
      inFence,
      fenceMatch,
      fenceLines,
    },
  };
}

// ── Inline delimiter block transform ─────────────────────────────

function processBuffer(
  text: string,
  opts: BlockTransformOptions,
): { blocks: ContentBlock[]; pending: string } {
  const blocks: ContentBlock[] = [];
  let i = 0;

  while (i < text.length) {
    const openIdx = text.indexOf(opts.open, i);
    if (openIdx === -1) {
      // No more delimiters — everything is safe text
      const remainder = text.slice(i);
      if (remainder) blocks.push({ type: "text", text: remainder });
      return { blocks, pending: "" };
    }

    const searchFrom = openIdx + opts.open.length;
    const closeIdx = text.indexOf(opts.close, searchFrom);
    if (closeIdx === -1) {
      // Unclosed delimiter — emit text before, hold back from delimiter
      const before = text.slice(i, openIdx);
      if (before) blocks.push({ type: "text", text: before });
      return { blocks, pending: text.slice(openIdx) };
    }

    // Complete match
    const before = text.slice(i, openIdx);
    if (before) blocks.push({ type: "text", text: before });

    const inner = text.slice(searchFrom, closeIdx).trim();
    const result = opts.transform(inner);

    if (result === null) {
      // Transform declined — keep original text with delimiters
      blocks.push({ type: "text", text: opts.open + inner + opts.close });
    } else if (Array.isArray(result)) {
      blocks.push(...result);
    } else {
      blocks.push(result);
    }

    i = closeIdx + opts.close.length;
  }

  return { blocks, pending: "" };
}
