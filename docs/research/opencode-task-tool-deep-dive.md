# Research: OpenCode `task` Tool — Deep Dive

## Objective

Understand OpenCode's built-in `task` tool and related subagent/permission infrastructure in detail, to evaluate how our `@alkdev/open-tasks` plugin (taskgraph analysis) can combine with or extend the built-in task tool.

---

## 1. Tool Definition and Parameters

**File**: `/workspace/opencode/packages/opencode/src/tool/task.ts` (166 lines)

### Parameters Schema

```typescript
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z.string()
    .describe("This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)")
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | yes | Short 3-5 word description of the task |
| `prompt` | string | yes | Full task instructions for the subagent |
| `subagent_type` | string | yes | Which specialized agent to spawn (e.g., `general`, `explore`, custom agents) |
| `task_id` | string | no | Resume an existing subagent session instead of creating a new one |
| `command` | string | no | The slash command that triggered this task (if applicable) |

### Execution Flow

The tool's `execute` method has this flow:

1. **Fetch config** (`Config.get()`)
2. **Permission check** — Skip if `ctx.extra?.bypassAgentCheck` is true (used for slash commands and `@agent` invocations), otherwise call `ctx.ask()` with `permission: "task"`, `patterns: [params.subagent_type]`, `always: ["*"]`
3. **Agent lookup** — `Agent.get(params.subagent_type)` throws if unknown
4. **Permission inheritance** — Determine inherited permissions:
   - If the agent does NOT have `task` permission → deny `task: *` on the spawned session
   - If the agent does NOT have `todowrite` permission → deny `todowrite: *` on the spawned session
   - Also add permissions from `config.experimental?.primary_tools` as "allow" rules on the session
5. **Session creation** — Either reuse existing session (if `task_id` provided and found) or create a new child session with:
   - `parentID: ctx.sessionID` (links child to parent)
   - `title: params.description + " (@agent_name subagent)"`
   - Permission overrides as determined above
6. **Model resolution** — Use agent's configured model, or fall back to the caller's model
7. **Metadata update** — Set title and metadata on the tool result part
8. **Prompt resolution** — `SessionPrompt.resolvePromptParts(params.prompt)` resolves file references and agent references
9. **Subagent execution** — Call `SessionPrompt.prompt()` with:
   - The subagent's session ID and model
   - `agent: agent.name`
   - `tools` dict disabling inherited tools (e.g., `{ todowrite: false, task: false }`)
   - The resolved prompt parts
10. **Result extraction** — Extract last text part from result
11. **Return** — Format output as:
    ```
    task_id: <session_id> (for resuming to continue this task if needed)

    <task_result>
    <extracted text>
    </task_result>
    ```

### Key Code Snippet — Tool Filtering by Agent Permissions

```typescript
// Lines 66-96 of task.ts
const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

const session = await iife(async () => {
  if (params.task_id) {
    const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
    if (found) return found
  }
  return await Session.create({
    parentID: ctx.sessionID,
    title: params.description + ` (@${agent.name} subagent)`,
    permission: [
      ...(hasTodoWritePermission ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
      ...(hasTaskPermission ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
      ...(config.experimental?.primary_tools?.map((t) => ({ pattern: "*", action: "allow" as const, permission: t })) ?? []),
    ],
  })
})
```

### Key Code Snippet — Tool Disabling

```typescript
// Lines 138-141 of task.ts
tools: {
  ...(hasTodoWritePermission ? {} : { todowrite: false }),
  ...(hasTaskPermission ? {} : { task: false }),
  ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
},
```

This means subagents spawned by the `task` tool **cannot spawn their own subagents by default** (task is denied) unless the subagent has explicit `task` permission. This is a critical recursive-prevention mechanism.

---

## 2. Description / Prompt (task.txt)

**File**: `/workspace/opencode/packages/opencode/src/tool/task.txt` (60 lines)

### Full Text

```
Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
{agents}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When to use the Task tool:
- When you are instructed to execute custom slash commands. Use the Task tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description="Check the file", prompt="/check-file path/to/file.py")

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.
3. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).
6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask you for it first. Use your judgement.

Example usage (NOTE: The agents below are fictional examples for illustration only - use the actual agents listed above):

<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a significant piece of code
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the Write tool to write a function that checks if a number is prime
...
</example>
```

### Dynamic `{agents}` Placeholder

The `{agents}` placeholder is replaced at tool initialization time with a sorted list of available non-primary agents:

```typescript
// Lines 29-36 of task.ts
const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
const caller = ctx?.agent
const accessibleAgents = caller
  ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
  : agents
const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))
```

This means the description shown to the LLM **filters agents by the current agent's permissions** — if the calling agent has `task: { "explore": "deny" }`, the `explore` agent won't appear in the list.

---

## 3. How Subagents Work

### Subagent Session Creation

When `task` is invoked, a subagent session is created with:

- **`parentID`**: Set to the current session's ID, creating a parent-child relationship
- **`title`**: `description + " (@agent_name subagent)"`
- **`permission`**: Merged rules that disable `task` and `todowrite` by default, plus any `primary_tools` config

### Subtask Handling in prompt.ts

**File**: `/workspace/opencode/packages/opencode/src/session/prompt.ts` (lines 553-741)

The `handleSubtask` function manages the subagent execution lifecycle:

1. Creates an **assistant message** in the **parent session** (not the subagent session) with `mode: task.agent`
2. Creates a **tool part** on that message marking the task tool as running
3. Triggers `plugin.trigger("tool.execute.before", ...)` for tool observability
4. Validates that the requested agent exists
5. Calls `taskTool.execute(taskArgs, ctx)` where ctx has `bypassAgentCheck: true`
6. On completion, updates the tool part status to `"completed"` or `"error"`
7. If the task was triggered by a command, adds a synthetic user message: "Summarize the task tool output above and continue with your task."

### The `@agent` Shortcut

When a user types `@agent_name` in their message, the system creates a `SubtaskPart`:

```typescript
// MessageV2.SubtaskPart schema
export const SubtaskPart = PartBase.extend({
  type: z.literal("subtask"),
  prompt: z.string(),
  description: z.string(),
  agent: z.string(),
  model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }).optional(),
  command: z.string().optional(),
})
```

In `resolvePart` (line 1238+), agent parts check permissions:

```typescript
if (part.type === "agent") {
  const perm = Permission.evaluate("task", part.name, ag.permission)
  const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
  return [
    { ...part, messageID: info.id, sessionID: input.sessionID },
    {
      messageID: info.id,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      text: " Use the above message and context to generate a prompt and call the task tool with subagent: " + part.name + hint,
    },
  ]
}
```

### Context Inheritance

The subagent receives:
- The same project directory and worktree
- A fresh session (with parent reference)
- The agent's configured model and system prompt
- The prompt text passed to the task tool (resolved for file/agent references)
- Permission restrictions (no task recursion, no todowrite unless allowed)

The subagent does **NOT** inherit the parent's conversation history — it starts fresh unless `task_id` is provided to resume an existing session.

---

## 4. Tool Registration

**File**: `/workspace/opencode/packages/opencode/src/tool/registry.ts` (224 lines)

### Tool List Order

```typescript
// Lines 118-138
return [
  InvalidTool,
  ...(question ? [QuestionTool] : []),
  BashTool,
  ReadTool,
  GlobTool,
  GrepTool,
  EditTool,
  WriteTool,
  TaskTool,         // <-- Built-in task tool
  WebFetchTool,
  TodoWriteTool,
  WebSearchTool,
  CodeSearchTool,
  SkillTool,
  ApplyPatchTool,
  ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
  ...(cfg.experimental?.batch_tool === true ? [BatchTool] : []),
  ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
  ...custom,        // <-- Plugin/tools come AFTER built-ins
]
```

### Plugin Tool Registration

**Lines 64-86**: Plugin tools are wrapped via `fromPlugin()`:

```typescript
function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
  return {
    id,
    init: async (initCtx) => ({
      parameters: z.object(def.args),
      description: def.description,
      execute: async (args, toolCtx) => {
        const pluginCtx = {
          ...toolCtx,
          directory: ctx.directory,
          worktree: ctx.worktree,
        } as unknown as PluginToolContext
        const result = await def.execute(args as any, pluginCtx)
        const out = await Truncate.output(result, {}, initCtx?.agent)
        return {
          title: "",
          output: out.truncated ? out.content : result,
          metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
        }
      },
    }),
  }
}
```

### How Plugins Are Loaded

Two sources of custom tools:

1. **File-based tools** (lines 88-101): Scanned from `{tool,tools}/*.{js,ts}` in config directories
2. **Plugin-provided tools** (lines 103-108): From `plugin.tool` entries registered by loaded plugins

### There Is NO Deduplication or Override Mechanism

**Critical finding**: The tool list is built as `[..., built-in tools, ...custom]` with **no deduplication by ID**. Looking at the `register` function (lines 141-148):

```typescript
const register = Effect.fn("ToolRegistry.register")(function* (tool: Tool.Info) {
  const s = yield* InstanceState.get(state)
  const idx = s.custom.findIndex((t) => t.id === tool.id)
  if (idx >= 0) {
    s.custom.splice(idx, 1, tool)  // Replace existing custom tool
    return
  }
  s.custom.push(tool)
})
```

This only deduplicates within the `custom` array. **There is no mechanism for a plugin tool to override a built-in tool of the same name.** If a plugin registers a tool with `id: "task"`, it would appear as a second tool alongside the built-in `TaskTool`.

However, when the `tools()` method builds the final list (lines 157-195), it processes all tools and calls `tool.init()` for each. The AI SDK then uses these tools by their `id` field. Since `tool.id` is used as the key in the AI SDK tool map, and JavaScript maps use last-write-wins semantics, **the last tool added with a given ID will be the one that the AI SDK uses**.

Looking at lines 436-474 of prompt.ts:

```typescript
for (const item of yield* registry.tools(...)) {
  // ...
  tools[item.id] = tool({...})  // Last write wins!
}
```

Since plugin tools come **after** built-in tools in the array, a plugin tool with `id: "task"` would actually **override** the built-in task tool in the final tool map! The OpenCode documentation's claim that "if a plugin tool has the same name as a built-in tool, the plugin tool takes priority" is effectively correct, but the mechanism is just array ordering + last-write-wins in a JS object, not explicit deduplication.

### Verification

Actually, let me re-examine. The AI SDK uses `tool()` and stores tools in an object keyed by `id`:

```typescript
// Line 441
tools[item.id] = tool({
  id: item.id as any,
  // ...
})
```

Since items are iterated in order and `[...builtIn, ...custom]`, **a plugin tool with the same `id` as a built-in tool will overwrite the built-in** in the `tools` object. This confirms: **a plugin CAN shadow the built-in `task` tool**.

---

## 5. Permissions

### Permission Schema (config.ts)

**Lines 416-446**:

```typescript
export const Permission = z
  .preprocess(
    permissionPreprocess,
    z.object({
      __originalKeys: z.string().array().optional(),
      read: PermissionRule.optional(),
      edit: PermissionRule.optional(),
      glob: PermissionRule.optional(),
      grep: PermissionRule.optional(),
      list: PermissionRule.optional(),
      bash: PermissionRule.optional(),
      task: PermissionRule.optional(),              // <-- Task permission
      external_directory: PermissionRule.optional(),
      todowrite: PermissionAction.optional(),         // Simple allow/deny/ask
      question: PermissionAction.optional(),
      webfetch: PermissionAction.optional(),
      websearch: PermissionAction.optional(),
      codesearch: PermissionAction.optional(),
      lsp: PermissionRule.optional(),
      doom_loop: PermissionAction.optional(),
      skill: PermissionRule.optional(),
    })
    .catchall(PermissionRule)
    .or(PermissionAction),
  )
  .transform(permissionTransform)
```

### Permission Types

```typescript
// Simple: just "allow", "deny", or "ask"
export const PermissionAction = z.enum(["ask", "allow", "deny"])

// Complex: pattern-based rules
export const PermissionRule = z.union([PermissionAction, PermissionObject])
// where PermissionObject = z.record(z.string(), PermissionAction)
// e.g., { "explore": "allow", "*": "ask" }
```

### How `task` Permission Works

The `task` permission uses `PermissionRule`, meaning it supports both simple and pattern-based forms:

- `"task": "allow"` — Allow all subagent types
- `"task": "deny"` — Deny all subagent types
- `"task": { "explore": "allow", "*": "ask" }` — Allow `explore` agent, ask for others

### Permission Evaluation (evaluate.ts)

**File**: `/workspace/opencode/packages/opencode/src/permission/evaluate.ts` (15 lines)

```typescript
export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

Key behavior:
- Rules are evaluated with **last-match-wins** (via `findLast`)
- **Default is `ask`** — if no rule matches, the user is prompted
- `Wildcard.match` supports glob patterns like `*`

### Task Permission in Practice

In `task.ts` (lines 52-60):

```typescript
await ctx.ask({
  permission: "task",
  patterns: [params.subagent_type],
  always: ["*"],
  metadata: {
    description: params.description,
    subagent_type: params.subagent_type,
  },
})
```

This asks permission with:
- `permission: "task"` — The permission category
- `patterns: [params.subagent_type]` — The specific agent name (e.g., "explore")
- `always: ["*"]` — If the user says "always allow", the recorded rule will allow all patterns

The `ask()` method (permission/index.ts lines 166-201):

1. Flattens all rulesets (agent permissions + session permissions + approved persistent permissions)
2. Evaluates each pattern against the merged ruleset
3. If any pattern has `action: "deny"` → throws `DeniedError`
4. If all patterns have `action: "allow"` → proceeds silently
5. If any pattern has `action: "ask"` → prompts the user, creating a pending request
6. If user says "always" → records `{ permission, pattern: "*", action: "allow" }` to persistent storage

### Agent-Specific Permission Filtering

In `task.ts` (lines 29-36), the description dynamically filters agents:

```typescript
const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
const caller = ctx?.agent
const accessibleAgents = caller
  ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
  : agents
```

This means if agent X has `task: { "general": "deny" }`, the LLM won't even see `general` in the agent list when running as agent X.

---

## 6. Plugin Tool Override Capability

### Can Our Plugin Shadow the Built-in `task` Tool?

**Yes, absolutely.** Here's the evidence:

1. **Tool registration** (`registry.ts` line 137): Built-in tools come first, then `...custom` (plugin tools) are appended
2. **Tool resolution** (`prompt.ts` line 441): Tools are stored in a JS object `tools[item.id] = tool(...)`, which is **last-write-wins**
3. **No explicit deduplication**: The `register()` method only deduplicates within `custom`, not against built-ins

**Therefore**: If `@alkdev/open-tasks` registers a `tool` entry with `id: "task"`, it will overwrite the built-in `TaskTool` in the AI SDK's tool map.

### The Plugin Hook Alternative

Instead of shadowing, plugins can also use the `tool.definition` hook to modify built-in tool definitions:

```typescript
// From @opencode-ai/plugin Hooks type
"tool.definition"?: (input: { toolID: string }, output: {
  description: string;
  parameters: any;
}) => Promise<void>;
```

This hook is called in `resolveTools` (prompt.ts line 484):

```typescript
for (const item of yield* registry.tools(...)) {
  // ...
  const output = {
    description: next.description,
    parameters: next.parameters,
  }
  yield* plugin.trigger("tool.definition", { toolID: item.id }, output)
  // output may be mutated by plugins
}
```

This means a plugin could modify the `task` tool's description and parameters **without replacing it entirely**.

### Plugin Tool Interface

**File**: `/workspace/opencode/.opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts`

```typescript
type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void;
  ask(input: AskInput): Promise<void>;
};

type AskInput = {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: { [key: string]: any };
};

export function tool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>;
}): { description: string; args: Args; execute: (...) => Promise<string> };

export type ToolDefinition = ReturnType<typeof tool>;
```

Key difference from built-in tools: Plugin `execute()` returns just a `string`, not the `{ title, metadata, output }` object that built-in tools return. The registry wraps this in `fromPlugin()` to adapt.

### Important Limitation for Plugin Tools

Plugin tools receive a `ToolContext` that has `directory` and `worktree` — but they do **NOT** have access to the full `sessionID` context or ability to create sub-sessions. They are fundamentally simpler than built-in tools.

---

## 7. The `todowrite` Tool

**File**: `/workspace/opencode/packages/opencode/src/tool/todo.ts` (31 lines)

### Implementation

```typescript
export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })
    Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })
    return {
      title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
      output: JSON.stringify(params.todos, null, 2),
      metadata: { todos: params.todos },
    }
  },
})
```

### Todo Schema

**File**: `/workspace/opencode/packages/opencode/src/session/todo.ts`

```typescript
export const Info = z.object({
  content: z.string().describe("Brief description of the task"),
  status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
  priority: z.string().describe("Priority level of the task: high, medium, low"),
})
```

### Key Characteristics

- **Session-scoped**: Todos are stored per session in the database (SQLite via Drizzle)
- **Permission-controlled**: Requires `todowrite` permission; default is `"ask"` but many agents have it set to `"deny"`
- **Flat list**: No hierarchy, no dependencies between todos
- **Replaced on update**: `Todo.update()` does a DELETE + INSERT (delete all existing todos for the session, then insert the new list with positional ordering)
- **Status values**: `pending`, `in_progress`, `completed`, `cancelled`
- **Priority values**: `high`, `medium`, `low`

### todowrite.txt Description

The description (167 lines) instructs the LLM to use `todowrite` for complex multistep tasks with 3+ steps. Key guidelines:

1. Create todos for multistep/complex tasks
2. Mark tasks `in_progress` when starting (limit to one at a time)
3. Mark `completed` immediately after finishing
4. Cancel irrelevant tasks
5. Do NOT use for trivial single-step tasks

### How `todowrite` Differs from Our `tasks` Tool

| Feature | `todowrite` | `@alkdev/open-tasks` |
|---|---|---|
| Structure | Flat list | Graph (DAG with dependencies) |
| Persistence | Session-scoped SQLite | Markdown files with YAML frontmatter |
| Dependencies | None | `dependsOn` field |
| Analysis | None | Critical path, parallel groups, bottlenecks, risk analysis |
| Lifecycle | Within session only | Cross-session, version-controllable |
| Schema fields | `content`, `status`, `priority` | `id`, `name`, `status`, `dependsOn`, `scope`, `risk`, `impact`, `level` |
| Permission | `todowrite` (simple action) | N/A (file-based, no permission needed) |

---

## 8. Agent System

**File**: `/workspace/opencode/packages/opencode/src/agent/agent.ts` (420 lines)

### Built-in Agents

| Agent | Mode | Description | Key Permissions |
|---|---|---|---|
| `build` | primary | Default agent, executes tools based on permissions | Full access + `question: allow` + `plan_enter: allow` |
| `plan` | primary | Plan mode, disallows all edit tools | Full read + `question: allow` + `plan_exit: allow`, `edit: deny` |
| `general` | subagent | General-purpose research/execution | Default minus `todowrite: deny` |
| `explore` | subagent | Fast codebase exploration | Read-only: `grep, glob, list, bash, webfetch, websearch, codesearch, read` allowed; everything else denied |
| `compaction` | primary | Hidden, for context compaction | `*: deny` (no tools) |
| `title` | primary | Hidden, generates session titles | `*: deny` (no tools) |
| `summary` | primary | Hidden, generates summaries | `*: deny` (no tools) |

### Agent Configuration Schema

```typescript
export const Agent = z.object({
  model: ModelId.optional(),
  variant: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  prompt: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(), // @deprecated
  disable: z.boolean().optional(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  hidden: z.boolean().optional(),
  options: z.record(z.string(), z.any()).optional(),
  color: z.string().optional(),
  steps: z.number().int().positive().optional(),
  permission: Permission.optional(),
}).catchall(z.any())
```

### Agent Modes

- **`primary`**: Can be used as the main agent in a session (like `build` or `plan`)
- **`subagent`**: Can only be used via the `task` tool (like `general` or `explore`)
- **`all`**: Can function in both roles (default for custom agents)

### Agent Resolution Flow

1. Built-in agents are hard-coded in `agent.ts`
2. User config (`opencode.json`) can override built-in agent properties or define new agents via `agent` field
3. Agent `.md` files from `.opencode/agent/` directories are loaded via `ConfigMarkdown.parse()`
4. Disabled agents (`disable: true`) are removed from the list

### The `@agent` Subtask Mechanism

When a user types `@explore some question`, the system:
1. Creates a `SubtaskPart` with `{ type: "agent", name: "explore" }`
2. Resolves it to a text part: "Use the above message and context to generate a prompt and call the task tool with subagent: explore"
3. The primary agent then calls the `task` tool with `subagent_type: "explore"` and the prompt
4. This creates a child session and runs the explore agent in it

### Maximum Steps

Agents have a `steps` property that limits the number of agentic iterations:

```typescript
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
```

When `isLastStep` is true, a `MAX_STEPS` prompt is injected: "You have reached the maximum number of steps for this agent. Please provide your final response now without making any additional tool calls."

---

## 9. Implications for `@alkdev/open-tasks`

### What We Can Do

1. **Register as a separate tool** called `tasks` (plural) alongside the built-in `task` (singular). This is the **safest approach** — no conflict, both tools coexist.

2. **Shadow the built-in `task` tool** by registering a plugin tool with `id: "task"`. This would replace the built-in subagent spawning mechanism entirely. **This is probably not what we want** — the subagent system is deeply integrated with sessions, permissions, and the UI.

3. **Use the `tool.definition` hook** to modify the built-in `task` tool's description to reference taskgraph analysis. This would make the LLM aware of our plugin without replacing anything.

4. **Combine approaches**: Register as `tasks` (our analysis tool) and use the `tool.definition` hook to enhance the `task` tool's description to mention available task analysis from `tasks`.

### What We Should NOT Do

- **Replace the `task` tool**: It's deeply wired into the session/subagent system. Replacing it would break `@agent` mentions, slash commands, and the entire subagent orchestration.
- **Conflict with `todowrite`**: Our plugin operates on a different paradigm (graph-structured markdown files vs. session-scoped flat list). They serve complementary purposes.

### Recommended Architecture

```
User interacts with OpenCode
  ↓
LLM sees two tools:
  - `task` (built-in) — Spawns subagents for delegation
  - `tasks` (plugin) — Analyzes task graph, shows dependencies, etc.
  ↓
LLM can:
  - Use `tasks({ tool: "list" })` to see all tasks and their status
  - Use `tasks({ tool: "critical" })` to find the critical path
  - Use `task({ subagent_type: "general", prompt: "..." })` to delegate work
  - Use `todowrite({ todos: [...] })` for session-level progress tracking
```

This architecture is clean because:
- `task` = delegation ("who should do this work?")
- `tasks` = analysis ("what work needs to be done and in what order?")
- `todowrite` = progress tracking ("what am I working on right now?")

---

## File Index

| File | Path | Lines | Purpose |
|---|---|---|---|
| Task tool | `/workspace/opencode/packages/opencode/src/tool/task.ts` | 166 | Subagent spawning tool definition |
| Task description | `/workspace/opencode/packages/opencode/src/tool/task.txt` | 60 | System prompt for LLM about when to use task tool |
| Todo tool | `/workspace/opencode/packages/opencode/src/tool/todo.ts` | 31 | Session-scoped todo list tool |
| Todo description | `/workspace/opencode/packages/opencode/src/tool/todowrite.txt` | 167 | System prompt for LLM about when to use todowrite |
| Todo model | `/workspace/opencode/packages/opencode/src/session/todo.ts` | 57 | Todo data model (content, status, priority) |
| Tool registry | `/workspace/opencode/packages/opencode/src/tool/registry.ts` | 224 | Tool registration and resolution |
| Tool base | `/workspace/opencode/packages/opencode/src/tool/tool.ts` | 92 | Tool interface and `define()` helper |
| Agent system | `/workspace/opencode/packages/opencode/src/agent/agent.ts` | 420 | Agent definitions, config merging, generation |
| Agent CLI | `/workspace/opencode/packages/opencode/src/cli/cmd/agent.ts` | 245 | CLI for creating/listing agents |
| Config schema | `/workspace/opencode/packages/opencode/src/config/config.ts` | ~2000 | Full config schema including permissions, agents |
| Permission index | `/workspace/opencode/packages/opencode/src/permission/index.ts` | 322 | Permission system: ask/reply/evaluate/merge |
| Permission evaluate | `/workspace/opencode/packages/opencode/src/permission/evaluate.ts` | 15 | Wildcard-based rule evaluation (last-match-wins) |
| Permission schema | `/workspace/opencode/packages/opencode/src/permission/schema.ts` | 17 | PermissionID newtype |
| Permission arity | `/workspace/opencode/packages/opencode/src/permission/arity.ts` | 163 | Bash command arity dictionary |
| Session prompt | `/workspace/opencode/packages/opencode/src/session/prompt.ts` | 1906 | Main prompt/session loop, handleSubtask, resolveTools |
| Plugin system | `/workspace/opencode/packages/opencode/src/plugin/index.ts` | 281 | Plugin loading and hook infrastructure |
| Plugin types | `@opencode-ai/plugin` (node_modules) | ~258 | ToolDefinition, Hooks, Plugin interface |

---

## References

- OpenCode repository: `/workspace/opencode`
- Plugin SDK type definitions: `@opencode-ai/plugin` package
- Our project: `/workspace/@alkdev/open-tasks`