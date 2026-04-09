/**
 * File autocomplete extension.
 *
 * Provides @-triggered file path completion in agent input mode.
 * Responds to "autocomplete:request" pipe events by listing files
 * matching the path after the @ trigger.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "../types.js";

export default function activate({ bus, shell }: ExtensionContext): void {
  bus.onPipe("autocomplete:request", (payload) => {
    const atPos = payload.buffer.lastIndexOf("@");
    if (atPos < 0 || (atPos > 0 && payload.buffer[atPos - 1] !== " ")) {
      return payload;
    }
    const afterAt = payload.buffer.slice(atPos + 1);
    if (afterAt.includes(" ") || !/^[a-zA-Z0-9_.\/-]*$/.test(afterAt)) {
      return payload;
    }

    const files = listFiles(afterAt, shell.getCwd());
    if (files.length === 0) return payload;
    return { ...payload, items: [...payload.items, ...files] };
  });
}

function listFiles(
  query: string,
  cwd: string,
): { name: string; description: string }[] {
  const lastSlash = query.lastIndexOf("/");
  let searchDir: string;
  let prefix: string;
  let basePath: string;

  if (lastSlash >= 0) {
    basePath = query.slice(0, lastSlash + 1);
    searchDir = path.resolve(cwd, query.slice(0, lastSlash) || ".");
    prefix = query.slice(lastSlash + 1);
  } else {
    basePath = "";
    searchDir = cwd;
    prefix = query;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        e.name.toLowerCase().startsWith(prefix.toLowerCase()),
    )
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 15)
    .map((e) => ({
      name: basePath + e.name + (e.isDirectory() ? "/" : ""),
      description: e.isDirectory() ? "dir" : "",
    }));
}
