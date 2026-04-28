# Research: Open Coordinator Plugin — Deep Dive

## Metadata

| Field | Value |
|-------|-------|
| **Plugin** | `@alkdev/open-coordinator` v2.1.0 |
| **Repository** | `git@alk.dev:alkimiadev/open-coordinator` (fork of `0xSero/open-trees`) |
| **Source Path** | `/workspace/@alkimiadev/open-coordinator/` |
| **License** | MIT OR Apache-2.0 (dual) |
| **Runtime** | Bun, TypeScript (ESM, strict) |
| **Linter** | Biome |
| **Key Dependency** | `@opencode-ai/plugin` ^1.1.3, `jsonc-parser` ^3.3.1 |
| **Research Date** | 2026-04-28 |

---

## 1. Plugin Structure

### 1.1 Source Tree

```
src/
├── index.ts                 # Plugin entry point + hooks
├── tools.ts                 # Single `worktree` tool definition
├── registry.ts              # Handler dispatch — operations, role detection, routing
├── state.ts                 # Session-to-worktree state persistence (state.json)
├── config.ts                # Config path helpers (XDG_CONFIG_HOME)
├── git.ts                   # Git command runner + porcelain parser
├── paths.ts                 # Worktree path resolution + branch name normalization
├── format.ts                # Output formatting (tables, errors, commands)
├── result.ts                # ToolResult type (ok/error union)
├── sdk.ts                   # OpenCode SDK response unwrapping
├── status.ts                # Git status porcelain parser
├── session-helpers.ts       # TUI session helpers (openSessions, updateTitle)
├── opencode-config.ts       # JSONC config manipulation (for `add` CLI)
├── cli.ts                   # Standalone CLI: `open-coordinator add`
├── worktree.ts              # Core worktree CRUD (create, remove, prune, merge)
├── worktree-session.ts      # Session creation: start, open, fork
├── worktree-spawn.ts        # Async spawn with per-task prompts
├── worktree-swarm.ts        # Batch worktree+session creation
├── worktree-status.ts       # Per-worktree git status
├── worktree-dashboard.ts    # Aggregated dashboard (state + git + sessions)
├── worktree-helpers.ts      # Shared helpers (pathExists, findWorktreeMatch, etc.)
└── detection/
    ├── index.ts             # SSE subscription + event loop + stall detection
    ├── types.ts             # Types: SessionMetrics, AnomalyType, thresholds
    ├── heuristics.ts        # Detection rules: model degradation, errors, stalls
    ├── metrics.ts           # Per-session metric tracking + updates
    └── notify.ts            # Coordinator notification via session.promptAsync
```

### 1.2 Architecture Overview

The plugin follows the **single-tool registry pattern** (same as `@alkdev/open-memory`):

```
LLM calls: worktree({action: "spawn", args: {tasks: ["auth", "db"]}})
                              |
                              v
                    registry.ts: route(action, args, context)
                              |
                              v
                    handlers[action]  <-- Record<string, Handler>
                              |
                              v
                    handlers.spawn(args, context)  --> returns string
```

The key architect files and their responsibilities:

| File | Responsibility |
|------|---------------|
| `index.ts` | Plugin factory: creates tools, starts detection, sets up hooks |
| `tools.ts` | Defines the single `worktree` tool schema + calls registry |
| `registry.ts` | 17 operation handlers, role detection (`detectRole`), routing (`route`) |
| `state.ts` | JSON file I/O for `state.json`, session mapping CRUD |
| `git.ts` | Shell execution via `ctx$` for git commands |
| `worktree*.ts` | Implementation of each operation category |
| `detection/` | Real-time anomaly monitoring via SSE |

### 1.3 Build System

```bash
bun run build     # bun build src/index.ts src/cli.ts → dist/ + tsc declarations
bun run typecheck # tsc --noEmit
bun run lint      # biome check .
bun run format    # biome format --write .
bun run test      # bun test
```

---

## 2. Tool Definition

### 2.1 Single Tool: `worktree`

Defined in `src/tools.ts`:

```typescript
export const createTools = (ctx: PluginInput): Record<string, ToolDefinition> => ({
  worktree: tool({
    description: "Worktree coordinator: manage git worktrees, sessions, and communication...",
    args: {
      action: z.string().describe("Operation name: help, list, status, dashboard, ..."),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the operation."),
    },
    async execute(input, context) {
      const role = await detectRole(context.sessionID);
      return route(input.action, (input.args as Record<string, unknown>) ?? {}, {
        ctx,
        sessionID: context.sessionID,
        role,
      });
    },
  }),
});
```

Key design decisions:
- **One tool** rather than 17 separate tools (reduces agent context bloat)
- **`action` field** selects the operation (help, list, spawn, etc.)
- **`args` field** is a loose `Record<string, unknown>` — no per-operation schema validation
- **Role detection** happens on every invocation, not cached

### 2.2 Operations (17 total)

**Coordinator operations (16 accessible)**:

| Operation | Handler File | Description |
|-----------|-------------|-------------|
| `help` | registry.ts | Full reference or per-operation help |
| `list` | worktree.ts | List git worktrees |
| `status` | worktree-status.ts | Git status per worktree |
| `dashboard` | worktree-dashboard.ts | Aggregated state+git+session view |
| `create` | worktree.ts | Create worktree branch + checkout |
| `start` | worktree-session.ts | Worktree + fresh session |
| `open` | worktree-session.ts | Session in existing worktree |
| `fork` | worktree-session.ts | Worktree + forked session (parentID) |
| `swarm` | worktree-swarm.ts | Batch worktree+session creation |
| `spawn` | worktree-spawn.ts | Async per-task worktree+session+prompt |
| `message` | registry.ts (inline) | Send message to spawned session |
| `notify` | registry.ts (inline) | Report to coordinator session |
| `sessions` | registry.ts (inline) | Query spawned session status |
| `abort` | registry.ts (inline) | Abort a session + cleanup |
| `cleanup` | registry.ts → worktree.ts | Remove/prune/merged cleanup |
| `merge` | worktree.ts | Merge worktree branch into target |

**Implementation-only operations (4)**:

| Operation | Description |
|-----------|-------------|
| `help` | Filtered help |
| `current` | Show session's worktree mapping |
| `notify` | Send message to coordinator |
| `status` | Show worktree git status |

### 2.3 Registry / Dispatch Pattern

```typescript
// src/registry.ts

type Handler = (args: ToolArgs, hctx: HandlerContext) => Promise<HandlerResult>;
type HandlerContext = {
  ctx: PluginInput;
  sessionID?: string;
  role: "coordinator" | "implementation";
};

const COORDINATOR_OPS = new Set([
  "help", "list", "status", "dashboard", "create", "start", "open", "fork",
  "swarm", "spawn", "message", "notify", "sessions", "abort", "cleanup", "merge", "current"
]);

const IMPLEMENTATION_OPS = new Set(["help", "current", "notify", "status"]);

export const detectRole = async (sessionID?: string) => {
  if (!sessionID) return "coordinator";
  const entry = await findSessionEntry(sessionID);
  if (entry?.parentSessionID) return "implementation";
  return "coordinator";
};

export const route = async (action, args, hctx) => {
  const handler = handlers[action];
  if (!handler) return `Unknown operation: ${action}. Call worktree({action: "help"})...`;
  if (!isOpAllowed(action, hctx.role)) return formatError(`Operation "${action}" not available...`);
  try { return await handler(args, hctx); }
  catch (err) { return `Error in ${action}: ${err.message}`; }
};
```

Key points:
- Role detection is **per-invocation** via `findSessionEntry(sessionID)` — looks up `state.json`
- If session has `parentSessionID` → `implementation` role (limited operations)
- If no sessionID or no parentSessionID → `coordinator` role (all operations)
- Unknown actions return help suggestion, not errors
- Handler exceptions are caught and returned as strings

---

## 3. Worktree Orchestration

### 3.1 How Worktrees Are Created

The core creation path (in `worktree.ts`):

```typescript
export const createWorktreeDetails = async (ctx, options) => {
  const repoRoot = getRepoRoot(ctx);        // ctx.worktree
  const name = options.name?.trim() ?? "";
  const branch = options.branch || normalizeBranchName(name);
  const base = options.base?.trim() || "HEAD";
  const worktreePath = options.path
    ? resolveWorktreePath(repoRoot, options.path)
    : defaultWorktreePath(repoRoot, branch);  // <repo>/.worktrees/<branch>

  // Validate branch name
  await runGit(ctx, ["check-ref-format", "--branch", branch], { cwd: repoRoot });
  
  // Check if branch exists
  const branchExists = await runGit(ctx, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  
  const args = branchExists.ok
    ? ["worktree", "add", worktreePath, branch]           // existing branch
    : ["worktree", "add", "-b", branch, worktreePath, base]; // new branch from base
  
  await runGit(ctx, args, { cwd: repoRoot });
  return { branch, worktreePath, base, command, branchExists };
};
```

Git commands executed:
- `git rev-parse --show-toplevel` (via `ctx.worktree` → `getRepoRoot`)
- `git worktree list --porcelain` (list existing)
- `git check-ref-format --branch <name>` (validate branch name)
- `git show-ref --verify --quiet refs/heads/<branch>` (check existence)
- `git worktree add [-b <branch>] <path> [<base>]` (create)
- `git worktree remove [--force] <path>` (delete)
- `git worktree prune [--dry-run]` (cleanup stale refs)
- `git status --porcelain` (check dirty state)
- `git stash --include-untracked` / `git stash pop` (merge safety)
- `git checkout <target>` / `git merge <branch>` (merge flow)
- `git branch -d/-D <branch>` (branch cleanup)
- `git push <remote> --delete <branch>` (remote branch cleanup)

### 3.2 Path Resolution

```typescript
// Default: <repo>/.worktrees/<branch>
defaultWorktreePath(repoRoot, branch) = path.join(repoRoot, ".worktrees", branch)

// Relative paths resolved under .worktrees/ (prevents traversal)
resolveWorktreePath(repoRoot, "feat/auth") → /repo/.worktrees/feat/auth

// Absolute paths accepted as-is
resolveWorktreePath(repoRoot, "/custom/path") → /custom/path

// Traversal blocked
resolveWorktreePath(repoRoot, "../escape") → Error
```

### 3.3 Branch Name Normalization

```typescript
normalizeBranchName("Feature Auth Setup") → "feature-auth-setup"
// lowercases, replaces spaces/underscores with "-", 
// removes non-alphanumeric (except ./-), collapses multiple dashes
```

### 3.4 Removal Safety

- `removeWorktree` refuses dirty worktrees unless `force: true`
- Checks `git status --porcelain` before removal
- `cleanup` with `action: "merged"` lists branches merged into HEAD and deletes local branches
- Optional remote branch deletion with `remote: true`

---

## 4. Taskgraph CLI Usage

### 4.1 Finding: No Taskgraph CLI Usage

**There is zero usage of the Rust `taskgraph` CLI or any task-related dependency analysis in the open-coordinator plugin.** Comprehensive searches confirmed:

- No imports of `@alkdev/taskgraph`
- No invocations of `taskgraph` CLI binary
- No reading of task markdown files with frontmatter
- No dependency analysis, critical path, or decomposition logic
- No concept of task files, task IDs, or task dependencies

### 4.2 What "Tasks" Mean in Open Coordinator

In open-coordinator, the word "task" appears in two contexts, both of which refer to **human-provided string labels for worktree naming**, not structured task objects:

1. **`swarm`** — `tasks: string[]` parameter: An array of names used to derive branch names (e.g., `["auth-setup", "db-schema"]` → branches `wt/auth-setup`, `wt/db-schema`)
2. **`spawn`** — `tasks: string[]` parameter: Same naming convention, plus optional `prompt` template with `{{task}}` substitution

The `task` field in state entries is a simple string label:

```typescript
// state.ts
type WorktreeSessionEntry = {
  worktreePath: string;
  branch: string;
  sessionID: string;
  parentSessionID?: string;
  task?: string;            // ← Just a label, not a taskgraph object
  status?: SessionStatus;   // "active" | "completed" | "failed" | "aborted"
  createdAt: string;
  completedAt?: string;
};
```

### 4.3 What the AGENTS.md in open-tasks Says

The open-tasks AGENTS.md states:

> **open-coordinator** (`worktree`): git worktree orchestration, session spawning, anomaly detection

And:

> open-coordinator currently **presumes using the Rust taskgraph CLI**

This appears to be an **aspirational/planned integration** that does not yet exist in the open-coordinator codebase. The AGENTS.md in open-coordinator itself makes no reference to taskgraph.

---

## 5. Spawn vs Fork Concept

### 5.1 Session Creation Modes

There are **three distinct session creation APIs**, each with different semantics:

| Operation | Creates Worktree? | Creates Session? | Session Type | ParentID? | Prompt? |
|-----------|-------------------|------------------|-------------|-----------|---------|
| `start` | Yes (or reuse) | Yes | Fresh (`session.create`) | No | No |
| `fork` | Yes (or reuse) | Yes | Forked (`session.create` with `parentID`) | Yes | No |
| `spawn` | Yes | Yes | Fresh (`session.create` with `parentID`) | Yes | Yes (template) |

### 5.2 `start` — Fresh Session

```typescript
// worktree-session.ts: startWorktreeSession
const sessionResponse = await ctx.client.session.create({
  query: { directory: target.worktreePath },  // workdir set to worktree
  body: { title: `wt:${target.branch}` },     // NO parentID
});
// → Creates independent session, no context from coordinator
```

### 5.3 `fork` — Forked Session (Context Inheritance)

```typescript
// worktree-session.ts: forkWorktreeSession
const createResponse = await ctx.client.session.create({
  query: { directory: target.worktreePath },
  body: { title, parentID: sessionID },        // Inherits coordinator's context
});
// → Session starts with coordinator's conversation history
```

### 5.4 `spawn` — Fresh Session + Async Prompt (The Coordination Mode)

```typescript
// worktree-spawn.ts: spawnWorktrees
// 1. Create worktree for each task
// 2. Create session with parentID (for hierarchy tracking)
const createResponse = await ctx.client.session.create({
  query: { directory: worktreeResult.result.worktreePath },
  body: { title, parentID: parentSessionID },  // Hierarchy tracking
});
// 3. Store session mapping with parentSessionID + task
await storeSessionMapping({
  worktreePath, branch, sessionID,
  parentSessionID,          // ← This determines "implementation" role
  task: rawTask,            // ← Task name stored in state
  status: "active",
});
// 4. Send initial prompt if template provided
if (options.prompt) {
  const promptText = substituteTemplate(options.prompt, rawTask);
  await ctx.client.session.promptAsync({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: promptText }],
      ...(options.agent && { agent: options.agent }),
      ...(effectiveModel && { model: effectiveModel }),
    },
  });
}
```

### 5.5 Model Inheritance

Spawned sessions can inherit the coordinator's model:

```typescript
// worktree-spawn.ts: resolveCoordinatorModel
// Reads the coordinator's last assistant message to extract modelID + providerID
const response = await ctx.client.session.messages({ path: { id: coordinatorSessionID }, query: { limit: 20 } });
// Walks messages backwards to find the last assistant message with model info
```

This allows spawned sessions to use the same model as the coordinator by default, with an optional `model` override:
```typescript
model: { providerID: "anthropic", modelID: "claude-4-sonnet" }
```

### 5.6 The Coordination Logic

The coordination flow is:

1. **Coordinator** calls `spawn` with task names + prompt template
2. Plugin creates worktree + session + stores state mapping with `parentSessionID`
3. Plugin sends initial prompt to each session via `session.promptAsync`
4. Sessions run asynchronously in background
5. **Detection module** monitors sessions via SSE for anomalies
6. If anomalies detected → notifications sent to coordinator via `session.promptAsync`
7. Implementation sessions can `notify` coordinator using their `parentSessionID`
8. Coordinator can `message` any session, or `abort` stuck sessions

### 5.7 Swarm vs Spawn

| Feature | `swarm` | `spawn` |
|---------|---------|---------|
| Task names | Array of strings | Array of strings |
| Branch prefix | Configurable (default `wt/`) | Configurable (default `wt/`) |
| Initial prompt | None | Template with `{{task}}` substitution |
| Agent selection | None | Optional `agent` field |
| Model selection | Inherits coordinator | Inherits coordinator or explicit `model` |
| Session type | `session.create` with `parentID` | `session.create` with `parentID` |
| Open sessions UI | Optional `openSessions` flag | Not available |
| Error recovery | Skip on failure, continue | Clean up worktree+branch on failure |

---

## 6. Integration with OpenCode

### 6.1 Plugin API Usage

The plugin uses these OpenCode SDK/plugin interfaces:

```typescript
// Plugin factory
const OpenCoordinatorPlugin: Plugin = async (ctx) => {
  // ctx: PluginInput
  //   ctx.client: OpencodeClient (session, tui, app, global APIs)
  //   ctx.worktree: string (repo root path)
  //   ctx.project: { id, path }
  //   ctx.directory: string
  //   ctx.session: { id }
  //   ctx.$: ShellExecutor (for git commands)
  //   ctx.$.cwd(path): Scoped ShellExecutor
};
```

### 6.2 OpenCode Client APIs Used

| API | Usage |
|-----|-------|
| `ctx.client.session.create()` | Create sessions (start, open, fork, swarm, spawn) |
| `ctx.client.session.promptAsync()` | Send messages/prompts to sessions (spawn, message, notify) |
| `ctx.client.session.abort()` | Abort a session (abort operation) |
| `ctx.client.session.get()` | Get session info (dashboard) |
| `ctx.client.session.messages()` | Get session messages (resolve coordinator model) |
| `ctx.client.session.update()` | Update session title |
| `ctx.client.tui.openSessions()` | Open sessions UI panel |
| `ctx.client.app.log()` | Log messages to OpenCode |
| `ctx.client.global.event()` | SSE event stream (detection) |
| `ctx.$` / `ctx.$.cwd()` | Execute shell commands (git) |

### 6.3 Plugin Hooks Registered

```typescript
// index.ts
return {
  tool: createTools(ctx),              // Register worktree tool
  
  event: async ({ event }) => {        // Event handler
    // On session.deleted → remove state mappings + metrics
  },
  
  "tool.execute.before": async (input, output) => {
    // Auto-inject workdir for bash commands when session mapped to worktree
    if (input.tool === "bash" && input.sessionID) {
      const entry = await findSessionEntry(input.sessionID);
      if (entry && !output.args.workdir) {
        output.args.workdir = entry.worktreePath;
      }
    }
  },
  
  "shell.env": async (input, output) => {
    // Inject OPENCODE_WORKTREE_PATH + OPENCODE_WORKTREE_BRANCH env vars
    if (input.sessionID) {
      const entry = await findSessionEntry(input.sessionID);
      if (entry) {
        output.env.OPENCODE_WORKTREE_PATH = entry.worktreePath;
        output.env.OPENCODE_WORKTREE_BRANCH = entry.branch;
      }
    }
  },
  
  "experimental.session.compacting": async (_input, output) => {
    // Custom compaction prompt for spawned sessions
    output.prompt = `You are compacting your own session...`;
  },
};
```

Key hooks:
- **`tool.execute.before`**: Intercept bash commands → auto-set workdir to worktree path
- **`shell.env`**: Set environment variables in spawned session shells
- **`experimental.session.compacting`**: Custom prompt for context compaction
- **`event`**: Listen for `session.deleted` → cleanup state + metrics

### 6.4 Starting Detection on Plugin Load

```typescript
// index.ts
const OpenCoordinatorPlugin: Plugin = async (ctx) => {
  const _detectionController = startDetection(ctx);
  // ... reconciliation, hooks
};
```

The detection module starts an SSE event stream immediately on plugin load and runs indefinitely until the AbortController is triggered.

---

## 7. Configuration

### 7.1 Plugin Config

**Minimal configuration.** The plugin accepts no runtime config — it's just added to the plugin list:

```json
{
  "plugin": ["@alkdev/open-coordinator"]
}
```

There's no config schema like open-tasks' TypeBox-validated config. The only external config is:

- **State file**: `~/.config/opencode/open-coordinator/state.json` (or `${XDG_CONFIG_HOME}/opencode/open-coordinator/state.json`)
- **Environment variable**: `XDG_CONFIG_HOME` for config directory override

### 7.2 CLI Config Helper

The `src/cli.ts` provides a standalone installer:

```bash
bunx open-coordinator add
# → Updates opencode.json to add the plugin
# → Supports --config, --plugin, --dry-run flags
```

Uses `jsonc-parser` to safely modify the OpenCode JSONC config file.

### 7.3 State File Format

```json
{
  "entries": [
    {
      "worktreePath": "/repo/.worktrees/wt-auth-setup",
      "branch": "wt/auth-setup",
      "sessionID": "ses_abc123",
      "parentSessionID": "ses_coordinator456",
      "task": "auth-setup",
      "status": "active",
      "createdAt": "2026-04-28T10:00:00.000Z",
      "completedAt": null
    }
  ]
}
```

State operations are all file-based with atomic write (write to temp + rename):

```typescript
// state.ts: writeState
const tmpPath = path.join(tmpdir(), `open-coordinator-state-${Date.now()}-${random}.tmp`);
await writeFile(tmpPath, content);
await rename(tmpPath, statePath);
```

### 7.4 Detection Thresholds (Not Configurable)

```typescript
// detection/types.ts
DEFAULT_THRESHOLDS = {
  toolErrorThreshold: 5,      // >5 tool errors → HIGH_ERROR_COUNT
  malformedToolThreshold: 1,  // Any malformed tool → MODEL_DEGRADATION
  stallThresholdMs: 60_000,  // 60s no activity while busy → SESSION_STALL
  stallCheckIntervalMs: 30_000, // Check every 30s
}
```

---

## 8. Task-Related Logic (or Lack Thereof)

### 8.1 No Task Files, Dependencies, or Analysis

The open-coordinator plugin has **no concept of**:
- Task files (YAML frontmatter markdown)
- Task IDs or task metadata
- Task dependencies (`dependsOn`)
- Dependency graphs
- Critical path analysis
- Risk/impact/scope assessments
- Decomposition guidance
- Parallel group computation
- Bottleneck detection
- Workflow cost estimation

### 8.2 What It Has Instead

The closest concept to "tasks" in open-coordinator:

1. **Task names as labels**: The `swarm` and `spawn` operations accept `tasks: string[]` which are used purely as branch name stems. Example: `"auth-setup"` → branch `wt/auth-setup`.

2. **Task labels in state**: A `task?: string` field stored per session mapping, used for:
   - Dashboard display
   - Notify message prefixes (`[auth-setup] Done!`)
   - Anomaly notification formatting

3. **Prompt template substitution**: The `spawn` operation supports `prompt: "Your task: {{task}}"` which substitutes the task name into the prompt text.

4. **Sequential task processing**: `swarm` and `spawn` process tasks **sequentially** in a `for` loop — no parallelism, no dependency awareness, no ordering optimization.

### 8.3 Potential Integration Points for open-tasks

If open-tasks were to combine concepts with open-coordinator, the natural integration points would be:

1. **Task → Worktree Mapping**: Read task files from `tasks/` directory, use the task ID and metadata (scope, risk, dependencies) to drive worktree creation decisions
  
2. **Dependency-Aware Scheduling**: Use `@alkdev/taskgraph`'s `parallelGroups()` and `criticalPath()` to determine which tasks can be spawned in parallel vs. sequentially

3. **Decomposition-Guided Splits**: Use `shouldDecomposeTask()` to decide whether a task should be split before spawning

4. **Risk-Aware Priority**: Use task risk/impact levels to influence spawn order and model assignment

5. **Status Propagation**: Task status (pending → in-progress → completed) could be synced with session status (active → completed/failed)

---

## 9. Detection & Monitoring System

### 9.1 Architecture

```
Plugin Load → startDetection(ctx)
                    |
                    v
            SSE Stream (ctx.client.global.event)
                    |
                    v
            handleEvent(ctx, event, thresholds)
                    |
                    ├── Extract sessionID from event
                    ├── Check if spawned session (lookup in state.json)
                    ├── Update SessionMetrics (tool errors, malformed tools, activity time)
                    ├── checkAllAnomalies(metrics, thresholds)
                    └── If anomalies → notifyCoordinator(parentSessionID, ...)
                    
            + setInterval (stall detection every 30s)
                    |
                    v
            For each session in sessionMetrics Map:
              checkAllAnomalies → detect SESSION_STALL
              If stall → notifyCoordinator
```

### 9.2 Anomaly Types

| Type | Detection | Severity | Notification Action |
|------|-----------|----------|-------------------|
| `MODEL_DEGRADATION` | `tool === "tool"` in SSE events (malformed tool calls) | High | Suggests abort |
| `HIGH_ERROR_COUNT` | >5 tool errors in session | Medium | Suggests checking session |
| `SESSION_STALL` | No activity for 60s while `busy` | Medium | Suggests "please continue" message |

### 9.3 Notification Format

```
⚠️ ANOMALY DETECTED [wt/auth-setup]

Session: ses_abc123
Branch: wt/auth-setup
Issue: SESSION_STALL (medium severity)

No activity detected while session is busy.
Consider sending: "There was an error, please continue."

Run: worktree({action: "message", args: {sessionID: "ses_abc123", message: "please continue"}})
```

### 9.4 Known Issues

From `docs/known-issues.md`:
- SSE reconnection can cause listener accumulation (fixed with AbortController + sseMaxRetryAttempts: 15)
- `setInterval` for stall detection was not cleared on shutdown (fixed with abort listener)
- `sessionMetrics` Map grew unbounded (fixed with cleanup on session.deleted events)

---

## 10. Key Architectural Patterns & Design Decisions

### 10.1 Result Type Pattern

All operations return `ToolResult = { ok: true; output: string } | { ok: false; error: string }`:

```typescript
// result.ts
export type ToolResult = { ok: true; output: string } | { ok: false; error: string };
export const ok = (output: string): ToolResult => ({ ok: true, output });
export const err = (error: string): ToolResult => ({ ok: false, error });
```

Every handler returns a string — no structured data, no JSON. This maximizes LLM readability.

### 10.2 Git Command Execution

All git commands go through `runGit()`:

```typescript
export const runGit = async (ctx, args, options = {}) => {
  const shell = options.cwd ? ctx.$.cwd(options.cwd) : ctx.$;
  const result = await shell`git ${args}`.nothrow().quiet();
  return { ok: result.exitCode === 0, stdout, stderr, exitCode, command };
};
```

This uses OpenCode's shell executor (`ctx.$`) which provides sandboxed execution.

### 10.3 Session Mapping State Machine

Sessions have an implicit state machine:

```
active → completed (notify with level="info")
active → failed    (notify with level="blocking")
active → aborted   (abort operation)
```

The state file tracks `status` and `completedAt` but these are advisory — the OpenCode session lifecycle is the real authority.

### 10.4 Reconciliation on Startup

```typescript
// index.ts
const reconcileResult = await reconcileState();
// → Reads state.json, checks if each worktreePath still exists on disk
// → Removes orphaned entries (worktrees deleted outside the plugin)
```

### 10.5 Cleanup on Session Deletion

```typescript
// index.ts event handler
event: async ({ event }) => {
  const sessionID = getDeletedSessionId(event);
  if (!sessionID) return;
  deleteSessionMetrics(sessionID);     // Remove from detection Map
  await removeSessionMappings(sessionID); // Remove from state.json
}
```

---

## 11. Comparison: open-coordinator vs open-tasks

| Aspect | open-coordinator | open-tasks |
|--------|-----------------|------------|
| **Purpose** | Git worktree orchestration + agent session management | Task graph analysis, dependency scheduling, decomposition |
| **Core Library** | None (direct git + OpenCode SDK) | `@alkdev/taskgraph` (graphology-based) |
| **Data Source** | `state.json` (session mappings) | `tasks/` directory (YAML frontmatter markdown) |
| **Single Tool** | `worktree({action, args})` | `tasks({tool, args})` |
| **Registry Pattern** | Yes (17 operations) | Yes (15 operations) |
| **Role System** | Coordinator vs Implementation | No role system |
| **Task Concept** | Simple string labels for branches | Structured task objects with metadata |
| **Dependencies** | None | `dependsOn` graph analysis |
| **Analysis** | Anomaly detection (SSE) | Critical path, parallel groups, bottlenecks, risk |
| **Config** | None (just plugin list) | TypeBox-validated config with source options |
| **State** | File-based (`state.json`) | Task files on disk |
| **Detection** | Real-time SSE monitoring | No monitoring |

---

## 12. Recommendations for Integration

### 12.1 Complementary, Not Overlapping

Open-coordinator and open-tasks are **complementary**: one manages git worktrees + sessions, the other manages task analysis + scheduling. They don't compete — they fill different roles in the alk.dev trio.

### 12.2 Integration Opportunities

1. **Task-aware spawn**: open-tasks could provide `parallelGroups()` output to open-coordinator's `spawn` operation, creating worktrees in dependency order rather than arbitrary order.

2. **Risk-based model assignment**: Tasks with `risk: high` could automatically use more capable models in spawned sessions.

3. **Status propagation**: When a spawned session completes, open-tasks could update the task file's `status` field from `pending` to `completed`.

4. **Decomposition → swarm**: When `shouldDecomposeTask()` returns true, open-coordinator could automatically split a task into sub-tasks for parallel work.

5. **Critical path awareness**: open-tasks' `criticalPath()` could inform open-coordinator about which tasks to prioritize for spawn ordering.

### 12.3 What open-coordinator Does NOT Need from open-tasks

- Role-based access (already implemented differently)
- Tool dispatch pattern (already shares same pattern)
- Anomaly detection (already has its own)
- State persistence (different domain — sessions vs. task graphs)

---

## References

- Source: `/workspace/@alkimiadev/open-coordinator/src/` (all files read in full)
- Architecture doc: `/workspace/@alkimiadev/open-coordinator/ARCHITECTURE.md`
- AGENTS.md: `/workspace/@alkimiadev/open-coordinator/AGENTS.md`
- README: `/workspace/@alkimiadev/open-coordinator/README.md`
- Known issues: `/workspace/@alkimiadev/open-coordinator/docs/known-issues.md`
- RESEARCH.md (historical): `/workspace/@alkimiadev/open-coordinator/RESEARCH.md`
- Tests: `/workspace/@alkimiadev/open-coordinator/tests/`