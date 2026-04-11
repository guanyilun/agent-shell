import type { ToolDefinition } from "../types.js";
import { discoverSkills } from "../skills.js";

export function createListSkillsTool(getCwd: () => string): ToolDefinition {
  return {
    name: "list_skills",
    description:
      "List available skills. Use read_file on a skill's path to load its full instructions.",
    input_schema: {
      type: "object",
      properties: {},
    },

    showOutput: false,

    async execute() {
      const skills = discoverSkills(getCwd());
      if (skills.length === 0) {
        return {
          content: "No skills found.",
          exitCode: 0,
          isError: false,
        };
      }

      const lines = skills.map(
        (s) => `${s.name}  ${s.filePath}\n  ${s.description}`,
      );

      return {
        content: lines.join("\n\n"),
        exitCode: 0,
        isError: false,
      };
    },
  };
}
