/**
 * Unicode math transform extension.
 *
 * Demonstrates the content transform pipeline by replacing LaTeX-style
 * math notation in agent responses with Unicode equivalents:
 *
 *   $\alpha + \beta$  →  α + β
 *   $x^2 + y^2$      →  x² + y²
 *   $\sqrt{x}$       →  √x
 *   $\sum_{i=0}^{n}$ →  ∑ᵢ₌₀ⁿ
 *
 * This extension showcases:
 *   - onPipe transform: modifies text before any renderer sees it
 *   - Streaming buffer: holds back partial $...$ across chunk boundaries
 *   - Flush on response-done: drains remaining buffer when response ends
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/math-render.ts
 */
import type { ExtensionContext } from "agent-sh/types";

// ── LaTeX → Unicode mappings ─────────────────────────────────────

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ",
  chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SYMBOLS: Record<string, string> = {
  infty: "∞", infinity: "∞", pm: "±", mp: "∓",
  times: "×", div: "÷", cdot: "·", star: "⋆",
  leq: "≤", geq: "≥", neq: "≠", approx: "≈",
  equiv: "≡", sim: "∼", propto: "∝",
  sum: "∑", prod: "∏", int: "∫",
  partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
  in: "∈", notin: "∉", subset: "⊂", supset: "⊃",
  subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩",
  emptyset: "∅", sqrt: "√",
  to: "→", rightarrow: "→", leftarrow: "←",
  Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔",
  langle: "⟨", rangle: "⟩",
  ldots: "…", cdots: "⋯", vdots: "⋮",
};

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  "n": "ⁿ", "i": "ⁱ", "k": "ᵏ", "x": "ˣ",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ",
  "n": "ₙ", "o": "ₒ", "r": "ᵣ", "x": "ₓ",
};

// ── Transform logic ──────────────────────────────────────────────

function toSuperscript(s: string): string {
  return [...s].map((c) => SUPERSCRIPTS[c] ?? c).join("");
}

function toSubscript(s: string): string {
  return [...s].map((c) => SUBSCRIPTS[c] ?? c).join("");
}

/** Transform a single LaTeX math expression (content between $...$). */
function transformMath(expr: string): string {
  let out = expr;

  // \command → symbol
  out = out.replace(/\\([a-zA-Z]+)/g, (_, cmd: string) => {
    return GREEK[cmd] ?? SYMBOLS[cmd] ?? `\\${cmd}`;
  });

  // \sqrt{...}  (already replaced \sqrt → √, now handle braces)
  out = out.replace(/√\{([^}]+)\}/g, "√($1)");
  out = out.replace(/√([a-zA-Z0-9])/g, "√$1");

  // Superscripts: ^{...} or ^x
  out = out.replace(/\^{([^}]+)}/g, (_, content: string) => toSuperscript(content));
  out = out.replace(/\^([a-zA-Z0-9])/g, (_, ch: string) => toSuperscript(ch));

  // Subscripts: _{...} or _x
  out = out.replace(/_{([^}]+)}/g, (_, content: string) => toSubscript(content));
  out = out.replace(/_([a-zA-Z0-9])/g, (_, ch: string) => toSubscript(ch));

  // \frac{a}{b} → a/b
  out = out.replace(/\\frac{([^}]+)}{([^}]+)}/g, "$1/$2");

  // Clean up remaining braces
  out = out.replace(/[{}]/g, "");

  return out;
}

/**
 * Split text at a safe boundary — everything before an unmatched `$` is safe
 * to emit. Returns { ready, pending } where pending may contain a partial `$...`.
 */
function splitAtSafeBoundary(text: string): { ready: string; pending: string } {
  // Process all complete $...$ pairs
  let result = "";
  let i = 0;

  while (i < text.length) {
    const openIdx = text.indexOf("$", i);
    if (openIdx === -1) {
      // No more $ — everything is safe
      result += text.slice(i);
      return { ready: result, pending: "" };
    }

    // Check for display math $$...$$
    const isDisplay = text[openIdx + 1] === "$";
    const delimiter = isDisplay ? "$$" : "$";
    const searchFrom = openIdx + delimiter.length;

    const closeIdx = text.indexOf(delimiter, searchFrom);
    if (closeIdx === -1) {
      // Unclosed $ — hold back from the $ onward
      result += text.slice(i, openIdx);
      return { ready: result, pending: text.slice(openIdx) };
    }

    // Complete match — transform it
    const inner = text.slice(openIdx + delimiter.length, closeIdx);
    result += text.slice(i, openIdx) + transformMath(inner);
    i = closeIdx + delimiter.length;
  }

  return { ready: result, pending: "" };
}

// ── Extension entry point ────────────────────────────────────────

export default function activate({ bus }: ExtensionContext) {
  let buffer = "";

  bus.onPipe("agent:response-chunk", (e) => {
    buffer += e.text;
    const { ready, pending } = splitAtSafeBoundary(buffer);
    buffer = pending;
    return { ...e, text: ready };
  });

  // Flush remaining buffer when response ends
  bus.onPipe("agent:response-done", (e) => {
    if (buffer) {
      // Pattern never closed — emit raw text through the transform pipe
      bus.emitTransform("agent:response-chunk", { text: buffer });
      buffer = "";
    }
    return e;
  });
}
