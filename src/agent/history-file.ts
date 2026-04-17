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
   */
  async readRecent(maxEntries?: number): Promise<NuclearEntry[]> {
    maxEntries ??= getSettings().historyStartupEntries;
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const lines = content.trim().split("\n").filter(Boolean);
    // Read more than needed so we still get maxEntries after filtering
    const oversample = lines.slice(-(maxEntries * 3));
    const entries: NuclearEntry[] = [];
    for (const line of oversample) {
      const entry = deserializeEntry(line);
      if (entry && !isReadOnly(entry)) entries.push(entry);
    }
    return entries.slice(-maxEntries);
  }

  /**
   * Search history entries by regex/keyword.
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

    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }

    const results: { entry: NuclearEntry; line: string }[] = [];
    for (const line of content.trim().split("\n")) {
      const entry = deserializeEntry(line);
      if (!entry || isReadOnly(entry)) continue;
      // Search both the summary and the body — the body can contain up to
      // 4000 chars of the original content that the summary truncates away.
      const searchText = [entry.sum, entry.body].filter(Boolean).join("\n");
      if (regex.test(searchText)) {
        results.push({ entry, line: formatNuclearLine(entry) });
      }
    }
    return results;
  }

  /**
   * Find a single entry by sequence number. Returns null if not found.
   * Searches from the end of the file (most recent first).
   */
  async findBySeq(seq: number): Promise<NuclearEntry | null> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch {
      return null;
    }
    const lines = content.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = deserializeEntry(lines[i]!);
      if (entry && entry.seq === seq) return entry;
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
