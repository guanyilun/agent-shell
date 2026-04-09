/**
 * Shell recall extension.
 *
 * Intercepts __shell_recall terminal commands via the
 * "agent:terminal-intercept" pipe, returning virtual output from
 * ContextManager's recall API without spawning a subprocess.
 */
import type { EventBus } from "../event-bus.js";
import type { ContextManager } from "../context-manager.js";

export function shellRecall(bus: EventBus, contextManager: ContextManager): void {
  bus.onPipe("agent:terminal-intercept", (payload) => {
    if (!payload.command.trimStart().startsWith("__shell_recall")) return payload;
    const output = contextManager.handleRecallCommand(payload.command.trim());
    return { ...payload, intercepted: true, output };
  });
}
