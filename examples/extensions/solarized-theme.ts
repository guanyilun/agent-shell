/**
 * Solarized Dark theme extension.
 *
 * Overrides the default color palette with Solarized Dark colors.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/solarized-theme.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/solarized-theme.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

export default function activate({ setPalette }: ExtensionContext) {
  setPalette({
    accent:  "\x1b[38;2;38;139;210m",   // blue (#268bd2)
    success: "\x1b[38;2;133;153;0m",    // green (#859900)
    warning: "\x1b[38;2;181;137;0m",    // yellow (#b58900)
    error:   "\x1b[38;2;220;50;47m",    // red (#dc322f)
    muted:   "\x1b[38;2;88;110;117m",   // base01 (#586e75)

    successBg:     "\x1b[48;2;7;54;66m",    // base03 with green tint
    errorBg:       "\x1b[48;2;42;30;30m",   // base03 with red tint
    successBgEmph: "\x1b[48;2;20;70;50m",   // stronger green tint
    errorBgEmph:   "\x1b[48;2;70;30;30m",   // stronger red tint
  });
}
