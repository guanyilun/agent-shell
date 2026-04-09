import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileChange {
  path: string;
  relPath: string;
  before: string;
  after: string;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next",
  "__pycache__", ".venv", "vendor", ".cache", ".turbo",
]);
const MAX_FILES = 200;
const MAX_FILE_SIZE = 100_000; // 100 KB

/**
 * Snapshots the working directory before an agent prompt so that
 * file modifications made by **any** method (ACP writeTextFile,
 * the agent's own edit tools, shell commands, etc.) can be detected
 * and shown as an interactive diff preview.
 */
export class FileWatcher {
  private cwd: string;
  private baseline = new Map<string, string>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Recursively snapshot all text files in the working directory.
   * Skips common non-source directories, binary files, and files
   * exceeding MAX_FILE_SIZE.  Capped at MAX_FILES entries.
   */
  async snapshot(): Promise<void> {
    this.baseline.clear();
    let count = 0;

    const walk = async (dir: string) => {
      if (count >= MAX_FILES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count >= MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(full);
            if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
            const content = await fs.readFile(full, "utf-8");
            this.baseline.set(full, content);
            count++;
          } catch {
            // Skip binary / unreadable files
          }
        }
      }
    };

    await walk(this.cwd);
  }

  /** Update baseline after a write is approved (avoids double-reporting). */
  approve(absPath: string, content: string): void {
    this.baseline.set(absPath, content);
  }

  /** Detect all tracked files whose on-disk content differs from baseline. */
  async detectChanges(): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    for (const [absPath, baseline] of this.baseline) {
      let after: string;
      try {
        after = await fs.readFile(absPath, "utf-8");
      } catch {
        continue;
      }
      if (baseline !== after) {
        changes.push({
          path: absPath,
          relPath: path.relative(this.cwd, absPath),
          before: baseline,
          after,
        });
      }
    }
    return changes;
  }

  /** Revert a file to its baseline content. */
  async revert(absPath: string): Promise<void> {
    const baseline = this.baseline.get(absPath);
    if (baseline !== undefined) {
      await fs.writeFile(absPath, baseline, "utf-8");
    }
  }

  /** Clear all tracking state. */
  reset(): void {
    this.baseline.clear();
  }
}
