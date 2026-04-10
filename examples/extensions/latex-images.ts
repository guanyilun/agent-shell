/**
 * LaTeX image overlay extension.
 *
 * Renders $$...$$ equations as inline terminal images using the same
 * pipeline as Emacs org-mode: latex → dvipng.
 *
 * Uses the content transform pipeline (createBlockTransform + ContentBlock)
 * so the extension just defines delimiters and a transform function —
 * no manual buffering, no process.stdout hacks.
 *
 * Requirements:
 *   - latex and dvipng (typically from TeX Live: `brew install --cask mactex`)
 *   - iTerm2, WezTerm, Kitty, or Ghostty terminal
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/latex-images.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "agent-sh/types";

// Settings loaded in activate() via ctx.getExtensionSettings
let config = { dpi: 300, fgColor: "d4d4d4" };

/** Encode PNG as iTerm2 or Kitty inline image escape sequence. */
function encodeImage(data: Buffer): string {
  const b64 = data.toString("base64");
  if (process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm") {
    return `\x1b]1337;File=inline=1;size=${data.length};preserveAspectRatio=1:${b64}\x07`;
  }
  if (process.env.KITTY_WINDOW_ID || process.env.TERM_PROGRAM === "ghostty") {
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += 4096) {
      const chunk = b64.slice(i, i + 4096);
      const isLast = i + 4096 >= b64.length;
      chunks.push(i === 0
        ? `\x1b_Gf=100,t=d,a=T,m=${isLast ? 0 : 1};${chunk}\x1b\\`
        : `\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
    return chunks.join("");
  }
  return "";
}

// ── LaTeX rendering via latex + dvipng ───────────────────────────

const LATEX_TEMPLATE = (equation: string, fg: string) => `
\\documentclass[border=1pt]{standalone}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{xcolor}
\\begin{document}
\\color[HTML]{${fg}}
$\\displaystyle ${equation}$
\\end{document}
`;

let tmpDir: string | null = null;
let renderCounter = 0;

function ensureTmpDir(): string {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-img-"));
  }
  return tmpDir;
}

function renderEquation(equation: string): Buffer | null {
  const dir = ensureTmpDir();
  const idx = renderCounter++;
  const texPath = path.join(dir, `eq${idx}.tex`);
  const dviPath = path.join(dir, `eq${idx}.dvi`);
  const pngPath = path.join(dir, `eq${idx}.png`);

  try {
    fs.writeFileSync(texPath, LATEX_TEMPLATE(equation, config.fgColor));

    execSync(
      `latex -interaction=nonstopmode -output-directory="${dir}" "${texPath}"`,
      { timeout: 10000, stdio: "pipe", cwd: dir },
    );

    execSync(
      `dvipng -D ${config.dpi} -T tight -bg Transparent --truecolor -o "${pngPath}" "${dviPath}"`,
      { timeout: 10000, stdio: "pipe" },
    );

    return fs.readFileSync(pngPath);
  } catch (err) {
    if (process.env.DEBUG) {
      const msg = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
      process.stderr.write(`[latex-images] render failed: ${msg}\n`);
    }
    return null;
  }
}

// ── Extension entry point ────────────────────────────────────────

export default function activate(ctx: ExtensionContext) {
  const { bus } = ctx;

  // Load settings: ~/.agent-sh/settings.json → "latex-images": { dpi, fgColor }
  config = ctx.getExtensionSettings("latex-images", config);

  // Check for latex + dvipng
  try {
    execSync("latex --version", { stdio: "ignore", timeout: 3000 });
    execSync("dvipng --version", { stdio: "ignore", timeout: 3000 });
  } catch {
    bus.emit("ui:error", {
      message: "latex-images: latex and dvipng required (brew install --cask mactex)",
    });
    return;
  }

  // Handle inline $$...$$ display math
  ctx.createBlockTransform({
    open: "$$",
    close: "$$",
    transform(latex) {
      const png = renderEquation(latex);
      if (!png) return null;
      return { type: "image", data: png };
    },
  });

  // Advise the code block renderer — wrap the default syntax highlighter
  ctx.advise("render:code-block", (next, language: string, code: string, width: number) => {
    if (language !== "latex" && language !== "tex") return next(language, code, width);
    const png = renderEquation(code);
    if (!png) return next(language, code, width); // render failed — fall through
    ctx.call("render:image", png);
  });

  process.on("exit", () => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
}
