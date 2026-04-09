/**
 * Rainbow theme extension.
 *
 * Overrides the default color palette with vibrant rainbow colors.
 * Each semantic role gets a distinct hue from the rainbow spectrum.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/rainbow-theme.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/rainbow-theme.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

export default function activate({ setPalette, bus }: ExtensionContext) {
  console.log("🌈 Rainbow theme extension loading...");
  setPalette({
    // ── Rainbow spectrum foregrounds ─────────────────────────────
    accent:  "\x1b[38;2;138;43;226m",   // blue-violet (#8A2BE2)
    success: "\x1b[38;2;34;197;94m",    // green (#22C65E)
    warning: "\x1b[38;2;255;165;0m",    // orange (#FFA500)
    error:   "\x1b[38;2;255;69;0m",     // red-orange (#FF4500)
    muted:   "\x1b[38;2;147;51;234m",   // purple (#9336EA)

    // ── Rainbow-tinted backgrounds ───────────────────────────────
    successBg:     "\x1b[48;2;20;60;20m",     // subtle green tint
    errorBg:       "\x1b[48;2;60;20;10m",     // subtle red-orange tint
    successBgEmph: "\x1b[48;2;40;100;40m",    // stronger green tint
    errorBgEmph:   "\x1b[48;2;100;35;20m",    // stronger red-orange tint
  });
  console.log("🌈 Rainbow theme loaded successfully!");
}