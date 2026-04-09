/**
 * Shell recall extension.
 *
 * Intercepts __shell_recall terminal commands via the
 * "agent:terminal-intercept" pipe, returning virtual output from
 * ContextManager's recall API without spawning a subprocess.
 */
import type { ExtensionContext } from "../types.js";

export default function activate({ bus, contextManager }: ExtensionContext): void {
  bus.onPipe("agent:terminal-intercept", (payload) => {
    if (!payload.command.trimStart().startsWith("__shell_recall")) return payload;
    const output = contextManager.handleRecallCommand(payload.command.trim());
    return { ...payload, intercepted: true, output };
  });
}
