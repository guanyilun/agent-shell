/**
 * Questionnaire tool — the agent can ask the user one or more questions.
 *
 * Single question: simple option list with arrow key navigation.
 * Multiple questions: tab bar navigation between questions.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/questionnaire.ts
 */
import type { ExtensionContext } from "agent-sh/types";
import type { InteractiveSession, ToolExecutionContext } from "agent-sh/agent/types.js";
import { palette as p } from "agent-sh/utils/palette.js";

// ── Key matching ─────────────────────────────────────────────────

function isKey(data: string, key: string): boolean {
  switch (key) {
    case "up":     return data === "\x1b[A" || data === "\x1bOA";
    case "down":   return data === "\x1b[B" || data === "\x1bOB";
    case "left":   return data === "\x1b[D" || data === "\x1bOD";
    case "right":  return data === "\x1b[C" || data === "\x1bOC";
    case "enter":  return data === "\r" || data === "\n";
    case "escape": return data === "\x1b";
    case "tab":    return data === "\t";
    default:       return data === key;
  }
}

// ── Types ────────────────────────────────────────────────────────

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
}

interface Answer {
  id: string;
  value: string;
  label: string;
  index: number;
}

interface QuestionnaireResult {
  answers: Answer[];
  cancelled: boolean;
}

// ── Extension ────────────────────────────────────────────────────

export default function activate({ registerTool }: ExtensionContext) {
  registerTool({
    name: "questionnaire",
    displayName: "questionnaire",
    description:
      "Ask the user one or more questions with selectable options. " +
      "Use for clarifying requirements, getting preferences, or confirming decisions. " +
      "For single questions, shows a simple option list. " +
      "For multiple questions, shows a tab-based interface.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier" },
              label: { type: "string", description: "Short label for tab bar (defaults to Q1, Q2)" },
              prompt: { type: "string", description: "The full question text" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "string", description: "Value returned when selected" },
                    label: { type: "string", description: "Display label" },
                    description: { type: "string", description: "Optional description" },
                  },
                  required: ["value", "label"],
                },
              },
            },
            required: ["id", "prompt", "options"],
          },
        },
      },
      required: ["questions"],
    },

    async execute(args, _onChunk, ctx?: ToolExecutionContext) {
      if (!ctx?.ui) {
        return { content: "Error: interactive UI not available", exitCode: 1, isError: true };
      }

      const rawQuestions = args.questions as any[];
      if (!rawQuestions?.length) {
        return { content: "Error: no questions provided", exitCode: 1, isError: true };
      }

      const questions: Question[] = rawQuestions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
      }));

      const result = await ctx.ui.custom<QuestionnaireResult>(
        createSession(questions),
      );

      if (result.cancelled) {
        return { content: "User cancelled the questionnaire.", exitCode: 1, isError: false };
      }

      const lines = result.answers.map((a) => {
        const q = questions.find((q) => q.id === a.id);
        return `${q?.label ?? a.id}: ${a.index + 1}. ${a.label}`;
      });

      return { content: lines.join("\n"), exitCode: 0, isError: false };
    },

    getDisplayInfo: () => ({ kind: "execute" as const, icon: "?" }),

    formatCall(args) {
      const qs = (args.questions as any[]) ?? [];
      const labels = qs.map((q: any) => q.label || q.id).join(", ");
      return `${qs.length} question${qs.length !== 1 ? "s" : ""}${labels ? ` (${labels})` : ""}`;
    },
  });
}

// ── Interactive session ──────────────────────────────────────────

function createSession(questions: Question[]): InteractiveSession<QuestionnaireResult> {
  const isMulti = questions.length > 1;
  let tab = 0;
  let optionIdx = 0;
  const answers = new Map<string, Answer>();

  return {
    render(width) {
      const w = Math.min(80, width);
      const lines: string[] = [];
      const q = questions[tab];

      lines.push(`${p.muted}${"─".repeat(w)}${p.reset}`);

      // Tab bar for multi-question
      if (isMulti) {
        const tabs: string[] = [];
        for (let i = 0; i < questions.length; i++) {
          const answered = answers.has(questions[i].id);
          const active = i === tab;
          const box = answered ? "■" : "□";
          const label = ` ${box} ${questions[i].label} `;
          tabs.push(active
            ? `${p.accent}${p.bold}${label}${p.reset}`
            : `${p.muted}${label}${p.reset}`);
        }
        lines.push(` ${tabs.join(" ")}`);
        lines.push("");
      }

      // Question + options
      if (q) {
        lines.push(` ${q.prompt}`);
        lines.push("");
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i];
          const sel = i === optionIdx;
          const prefix = sel ? `${p.accent}> ${p.reset}` : "  ";
          lines.push(`${prefix}${sel ? p.accent : ""}${i + 1}. ${opt.label}${sel ? p.reset : ""}`);
          if (opt.description) {
            lines.push(`     ${p.muted}${opt.description}${p.reset}`);
          }
        }
      }

      lines.push("");
      lines.push(isMulti
        ? ` ${p.dim}Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel${p.reset}`
        : ` ${p.dim}↑↓ navigate • Enter select • Esc cancel${p.reset}`);
      lines.push(`${p.muted}${"─".repeat(w)}${p.reset}`);

      return lines;
    },

    handleInput(data, done) {
      const q = questions[tab];

      if (isKey(data, "escape")) {
        done({ answers: [], cancelled: true });
        return;
      }

      // Tab navigation
      if (isMulti) {
        if (isKey(data, "tab") || isKey(data, "right")) {
          tab = (tab + 1) % questions.length;
          optionIdx = 0;
          return;
        }
        if (isKey(data, "left")) {
          tab = (tab - 1 + questions.length) % questions.length;
          optionIdx = 0;
          return;
        }
      }

      if (!q) return;

      if (isKey(data, "up")) {
        optionIdx = Math.max(0, optionIdx - 1);
        return;
      }
      if (isKey(data, "down")) {
        optionIdx = Math.min(q.options.length - 1, optionIdx + 1);
        return;
      }

      if (isKey(data, "enter")) {
        const opt = q.options[optionIdx];
        answers.set(q.id, { id: q.id, value: opt.value, label: opt.label, index: optionIdx });

        if (!isMulti) {
          done({ answers: Array.from(answers.values()), cancelled: false });
          return;
        }

        // Advance to next unanswered or finish
        const unanswered = questions.findIndex((q) => !answers.has(q.id));
        if (unanswered === -1) {
          done({ answers: Array.from(answers.values()), cancelled: false });
        } else {
          tab = unanswered;
          optionIdx = 0;
        }
      }
    },
  };
}
