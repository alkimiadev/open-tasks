import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

const HELP_TEXT = `# Tasks Tool

Call \`tasks({tool: "<name>", args: {...}})\` to use one.

| Tool | Description | Key args |
|------|-------------|----------|
| list | List tasks in the project | status, scope |
| show | Show task details | id |
| deps | Show task dependencies (prerequisites) | id |
| dependents | Show tasks that depend on a task | id |
| validate | Validate all task files | — |
| critical | Show critical path | — |
| parallel | Show parallel execution groups | — |
| bottleneck | Show bottleneck analysis | — |
| risk | Show risk path and distribution | — |
| cost | Show workflow cost estimate | — |
| decompose | Check if a task should be decomposed | id |
| help | Show this reference, or details for a specific tool | tool |

Examples:
- \`tasks({tool: "list"})\`
- \`tasks({tool: "show", args: {id: "auth-setup"}})\`
- \`tasks({tool: "deps", args: {id: "auth-setup"}})\`
- \`tasks({tool: "critical"})\`
- \`tasks({tool: "help", args: {tool: "show"}})\``;

type ToolArgs = Record<string, unknown>;

type TaskHandler = (args: ToolArgs, ctx: PluginInput) => string | Promise<string>;

const handlers: Record<string, TaskHandler> = {
  help(args) {
    if (args.tool && typeof args.tool === "string") {
      return `Details for "${args.tool}" — coming soon. Full implementation pending.`;
    }
    return HELP_TEXT;
  },

  list() {
    return "Task listing — implementation pending. Tasks are read from the project's tasks/ directory.";
  },

  show(args) {
    const id = (args.id as string) ?? "unknown";
    return `Task details for "${id}" — implementation pending.`;
  },

  deps(args) {
    const id = (args.id as string) ?? "unknown";
    return `Dependencies for "${id}" — implementation pending.`;
  },

  dependents(args) {
    const id = (args.id as string) ?? "unknown";
    return `Dependents of "${id}" — implementation pending.`;
  },

  validate() {
    return "Task validation — implementation pending.";
  },

  critical() {
    return "Critical path analysis — implementation pending.";
  },

  parallel() {
    return "Parallel execution groups — implementation pending.";
  },

  bottleneck() {
    return "Bottleneck analysis — implementation pending.";
  },

  risk() {
    return "Risk path analysis — implementation pending.";
  },

  cost() {
    return "Workflow cost estimate — implementation pending.";
  },

  decompose(args) {
    const id = (args.id as string) ?? "unknown";
    return `Decomposition check for "${id}" — implementation pending.`;
  },
};

export function createTools(ctx: PluginInput): Record<string, ToolDefinition> {
  return {
    tasks: tool({
      description:
        'Task graph management: list, show, analyze dependencies, critical path, risk, and workflow cost. Call tasks({tool: "help"}) for full reference.',
      args: {
        tool: z
          .string()
          .describe(
            "Operation name: help, list, show, deps, dependents, validate, critical, parallel, bottleneck, risk, cost, decompose.",
          ),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Arguments for the operation. Call {tool: "help"} for details.'),
      },
      async execute(input, _context) {
        const toolName = input.tool;
        const toolArgs = (input.args as ToolArgs) ?? {};
        const handler = handlers[toolName];
        if (!handler) {
          return `Unknown operation: "${toolName}". Call tasks({tool: "help"}) for available operations.`;
        }
        try {
          return await handler(toolArgs, ctx);
        } catch (err) {
          return `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
