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
    buffer += e.text;
    const { blocks, pending } = processBuffer(buffer, opts);
    buffer = pending;
    // Merge our blocks with any existing blocks from previous transforms
    const existing = e.blocks ?? [];
    return { ...e, text: "", blocks: [...existing, ...blocks] };
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
