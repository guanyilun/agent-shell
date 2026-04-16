/**
 * Persistent history file — append-only JSONL at ~/.agent-sh/history.
 *
 * Multiple agent-sh instances can write concurrently — each line is under
 * PIPE_BUF so O_APPEND writes are atomic. Only truncation (which rewrites
 * the file) uses a lock file for safety.
 */
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { CONFIG_DIR, getSettings } from "../settings.js";
import {
  type NuclearEntry,
  serializeEntry,
  deserializeEntry,
  formatNuclearLine,
  isReadOnly,
} from "./nuclear-form.js";

const HISTORY_PATH = path.join(CONFIG_DIR, "history");
const LOCK_PATH = HISTORY_PATH + ".lock";
const LOCK_STALE_MS = 10_000; // consider lock stale after 10s
const MAX_SEARCH_RESULTS = 200; // cap to avoid unbounded scans on broad queries

export class HistoryFile {
  readonly instanceId: string;
  private filePath: string;

  constructor(opts?: { filePath?: string; instanceId?: string }) {
    this.filePath = opts?.filePath ?? HISTORY_PATH;
    this.instanceId = opts?.instanceId ?? crypto.randomBytes(2).toString("hex");
  }

  /**
   * Append entries atomically. Uses O_APPEND for concurrency safety.
   * Triggers truncation check after writing.
   */
  async append(entries: NuclearEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lines = entries.map((e) => serializeEntry(e) + "\n").join("");
    await fs.appendFile(this.filePath, lines, { flag: "a" });
    await this.maybeTruncate();
  }

  /**
   * Read the most recent N entries from the history file, filtered.
   * Read-only tool calls (read_file, grep, glob, ls) are excluded so
   * the returned entries are all meaningful conversation turns.
   *
   * Uses tail-reading: only reads the last ~200KB of the file,
   * expanding backward if needed to find enough non-read-only entries.
   */
  async readRecent(maxEntries?: number): Promise<NuclearEntry[]> {
    maxEntries ??= getSettings().historyStartupEntries;
    const { size } = await fs.stat(this.filePath).catch(() => ({ size: 0 }));
    if (size === 0) return [];

    // Start with the last 96KB — typically enough for 100+ non-read-only entries.
    // Each JSONL entry averages ~200 bytes after body caps, so 96KB ≈ ~480 entries.
    // With ~50% being read-only, that's ~240 meaningful entries — well over 100.
    const CHUNK_SIZE = 96 * 1024;
    let startOffset = Math.max(0, size - CHUNK_SIZE);
    let entries: NuclearEntry[] = [];

    while (true) {
      const readLen = size - startOffset;
      const buf = Buffer.alloc(readLen);
      const fd = await fs.open(this.filePath, "r");
      try {
        await fd.read(buf, 0, readLen, startOffset);
      } finally {
        await fd.close();
      }
      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);

      // If we didn't read from the start, the first line might be partial — skip it
      const startIndex = startOffset > 0 ? 1 : 0;

      entries = [];
      for (let i = startIndex; i < lines.length; i++) {
        const entry = deserializeEntry(lines[i]!);
        if (entry && !isReadOnly(entry)) entries.push(entry);
      }

      // Enough entries, or we've read the whole file
      if (entries.length >= maxEntries || startOffset === 0) break;

      // Expand backward by another chunk
      startOffset = Math.max(0, startOffset - CHUNK_SIZE);
    }

    return entries.slice(-maxEntries);
  }

  /**
   * Search history entries by regex/keyword.
   *
   * Uses chunked reading (96KB at a time) instead of loading the entire file.
   * For a 3MB file, this means 32 small reads vs one massive allocation.
   * Results are returned newest-first (backward scan order).
   */
  async search(query: string): Promise<{ entry: NuclearEntry; line: string }[]> {
    if (!query.trim()) return [];

    // Try raw query as regex; fallback to AND logic (all words must match)
    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      const words = query.split(/\s+/).filter((w) => w.length > 0);
      const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const lookaheads = escaped.map((w) => `(?=.*${w})`).join("");
      regex = new RegExp(lookaheads, "i");
    }

    const { size } = await fs.stat(this.filePath).catch(() => ({ size: 0 }));
    if (size === 0) return [];

    const CHUNK_SIZE = 96 * 1024;
    const results: { entry: NuclearEntry; line: string }[] = [];

    // Scan backward through the file in chunks — results come out newest-first.
    let offset = size;
    while (offset > 0 && results.length < MAX_SEARCH_RESULTS) {
      const chunkStart = Math.max(0, offset - CHUNK_SIZE);
      const readLen = offset - chunkStart;
      const buf = Buffer.alloc(readLen);
      const fd = await fs.open(this.filePath, "r");
      try {
        await fd.read(buf, 0, readLen, chunkStart);
      } finally {
        await fd.close();
      }
      const text = buf.toString("utf-8");
      // If we didn't read from byte 0, skip the first line (may be partial at boundary)
      const lines = text.split("\n");
      const startIndex = chunkStart > 0 ? 1 : 0;

      for (let i = lines.length - 1; i >= startIndex; i--) {
        const line = lines[i];
        if (!line) continue;
        const entry = deserializeEntry(line);
        if (!entry || isReadOnly(entry)) continue;
        // Search both the summary and the body — the body can contain up to
        // 4000 chars of the original content that the summary truncates away.
        const searchText = [entry.sum, entry.body].filter(Boolean).join("\n");
        if (regex.test(searchText)) {
          results.push({ entry, line: formatNuclearLine(entry) });
        }
      }

      offset = chunkStart;
    }

    return results;
  }

  /**
   * Find a single entry by sequence number. Returns null if not found.
   * Uses tail-reading — starts from the end of the file (most recent)
   * and expands backward until found or the entire file is scanned.
   */
  async findBySeq(seq: number): Promise<NuclearEntry | null> {
    const { size } = await fs.stat(this.filePath).catch(() => ({ size: 0 }));
    if (size === 0) return null;

    const CHUNK_SIZE = 96 * 1024;
    let startOffset = Math.max(0, size - CHUNK_SIZE);

    while (true) {
      const readLen = size - startOffset;
      const buf = Buffer.alloc(readLen);
      const fd = await fs.open(this.filePath, "r");
      try {
        await fd.read(buf, 0, readLen, startOffset);
      } finally {
        await fd.close();
      }
      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);
      const startIndex = startOffset > 0 ? 1 : 0;

      // Search from end (most recent first)
      for (let i = lines.length - 1; i >= startIndex; i--) {
        const entry = deserializeEntry(lines[i]!);
        if (entry && entry.seq === seq) return entry;
      }

      if (startOffset === 0) break;
      startOffset = Math.max(0, startOffset - CHUNK_SIZE);
    }
    return null;
  }

  /**
   * Get file size in bytes. Returns 0 if file doesn't exist.
   */
  async getSize(): Promise<number> {
    try {
      const stat = await fs.stat(this.filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  // ── Truncation ──────────────────────────────────────────────────

  /**
   * Truncate from the front if file exceeds historyMaxBytes.
   * Uses a lock file for the rewrite operation.
   */
  private async maybeTruncate(): Promise<void> {
    const maxBytes = getSettings().historyMaxBytes;
    const size = await this.getSize();
    // Only truncate when significantly over (150%) to avoid frequent rewrites
    if (size <= maxBytes * 1.5) return;

    const acquired = await this.acquireLock();
    if (!acquired) return; // another process is truncating

    try {
      let content: string;
      try {
        content = await fs.readFile(this.filePath, "utf-8");
      } catch {
        return;
      }

      const lines = content.split("\n").filter(Boolean);
      // Drop oldest lines until under maxBytes
      let totalBytes = Buffer.byteLength(content, "utf-8");
      let dropCount = 0;
      while (totalBytes > maxBytes && dropCount < lines.length - 1) {
        totalBytes -= Buffer.byteLength(lines[dropCount]! + "\n", "utf-8");
        dropCount++;
      }

      if (dropCount === 0) return;

      const remaining = lines.slice(dropCount).join("\n") + "\n";
      // Atomic rewrite: write temp → rename
      const tmpPath = this.filePath + ".tmp." + process.pid;
      await fs.writeFile(tmpPath, remaining);
      await fs.rename(tmpPath, this.filePath);
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<boolean> {
    try {
      // Check for stale lock
      try {
        const stat = await fs.stat(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(LOCK_PATH).catch(() => {});
        }
      } catch {
        // Lock doesn't exist — good
      }
      // O_EXCL ensures atomicity
      const fd = await fs.open(LOCK_PATH, fss.constants.O_CREAT | fss.constants.O_EXCL | fss.constants.O_WRONLY);
      await fd.close();
      return true;
    } catch {
      return false; // lock held by another process
    }
  }

  private async releaseLock(): Promise<void> {
    await fs.unlink(LOCK_PATH).catch(() => {});
  }
}
