---
status: draft
last_updated: 2026-04-28
---

# Open Tasks: Architecture Overview

Structured task management for OpenCode agents — graph analysis, dependency insight, decomposition guidance, and workflow cost estimation. Exposes a single `tasks` tool using a registry pattern to keep the agent's visible tool count minimal.

## Problem

The `taskgraph` Rust CLI provides task graph operations but requires shell invocation — agents must compose bash commands and parse plain-text output. This is error-prone, context-expensive, and gives no structural validation or rich formatting. The TypeScript core library (`@alkdev/taskgraph`) now provides all graph operations natively. This plugin wraps that library into an OpenCode tool interface so agents get first-class, structured access without leaving the conversation.

## What This Plugin Is

A **read-only analysis and query layer** on top of the project's `tasks/` directory. It:

- Reads task markdown files with YAML frontmatter via `@alkdev/taskgraph` parsing
- Constructs an in-memory `TaskGraph` per invocation
- Runs analysis functions (critical path, parallel groups, bottlenecks, risk, workflow cost, decomposition)
- Returns formatted markdown to the agent

## What This Plugin Is Not

- **Not a task editor** — it does not create, modify, or delete task files. Task creation and status updates are the agent's responsibility (Write/Edit tools).
- **Not a task runner** — it does not coordinate execution. That's the role of open-coordinator.
- **Not a persistence layer** — there is no database, no cache, no state between invocations. Each tool call reads files fresh.

## Architecture

### Single-Tool Registry Pattern

Following open-memory's proven approach, the plugin exposes **one tool** (`tasks`) with internal operation dispatch:

```
tasks({tool: "help"})                         → Show available operations
tasks({tool: "list"})                         → List tasks in project
tasks({tool: "show", args: {id: "..."}})      → Show task details
tasks({tool: "deps", args: {id: "..."}})      → Task prerequisites
tasks({tool: "dependents", args: {id: "..."}}) → Tasks depending on a task
tasks({tool: "validate"})                      → Validate all task files
tasks({tool: "topo"})                          → Topological ordering
tasks({tool: "cycles"})                        → Circular dependency detection
tasks({tool: "critical"})                      → Critical path
tasks({tool: "parallel"})                      → Parallel execution groups
tasks({tool: "bottleneck"})                  → Bottleneck analysis
tasks({tool: "risk"})                           → Risk path + distribution
tasks({tool: "cost"})                           → Workflow cost estimate
tasks({tool: "decompose", args: {id: "..."}})  → Decomposition guidance
```

**Why**: Each tool definition adds JSON schema to the system prompt (~200-300 tokens each). 14 operations as 14 separate tools = ~3500 tokens of tool definitions. The registry pattern collapses this to ~250 tokens (one tool schema) plus an on-demand help text the agent retrieves only when needed. This is the same math that drove open-memory's design.

### Component Structure

```
src/
├── index.ts              # Plugin entry: tool registration (no hooks in v1)
├── tools.ts              # Tool definition — single `tasks` tool with registry dispatch
├── registry.ts           # Operation registry (dispatch table, arg validation)
├── operations/            # Individual operation implementations
│   ├── help.ts            # Help reference and per-operation details
│   ├── list.ts            # List and filter tasks
│   ├── show.ts            # Show full task details
│   ├── deps.ts            # Show prerequisites
│   ├── dependents.ts      # Show dependents
│   ├── validate.ts        # Validate task files
│   ├── topo.ts            # Topological ordering
│   ├── cycles.ts          # Cycle detection
│   ├── critical.ts        # Critical path
│   ├── parallel.ts        # Parallel execution groups
│   ├── bottleneck.ts      # Bottleneck scores
│   ├── risk.ts            # Risk path + risk distribution
│   ├── cost.ts            # Workflow cost estimate
│   └── decompose.ts       # Decomposition guidance
└── formatting.ts          # Shared markdown formatting helpers
```

### Data Flow

Each operation follows the same pipeline:

```
Agent calls tasks({tool: "list", args: {status: "pending"}})
  │
  ├─ registry.ts validates tool name and args
  │
  ├─ Operation handler:
  │   │
  │   ├─ resolveTasksPath(ctx) → find project's tasks/ directory
  │   │
  │   ├─ parseTaskDirectory(tasksPath) → TaskInput[] from @alkdev/taskgraph
  │   │
  │   ├─ TaskGraph.fromTasks(inputs) → in-memory graph
  │   │
  │   ├─ Analysis function (e.g., parallelGroups(graph))
  │   │
  │   └─ format result as markdown
  │
  └─ Return formatted markdown to agent
```

There is no caching between calls. Each invocation reads files and builds a fresh graph. This is intentional — task files change as agents work, and stale data would be worse than redundant I/O.

### Task Discovery

The plugin needs to find the project's `tasks/` directory. Resolution order:

1. **Workspace root** — `<workspace>/tasks/` (where `workspace` comes from the OpenCode plugin context)
2. **Fallback** — `./tasks/` relative to CWD

The path is constrained: it must resolve to a directory named `tasks/` within the workspace. If a config-provided path escapes the workspace root (e.g., `../../etc/`), it is rejected. This prevents the plugin from reading arbitrary files outside the project.

If no tasks directory is found, operations return a clear error message explaining where they looked and how to create one.

## Operations Reference

### Query Operations

| Operation | Maps to | Key Args | Output |
|-----------|---------|----------|--------|
| `list` | `TaskGraph` iteration | `status`, `scope`, `risk` (filter) | Filtered task table |
| `show` | `graph.getTask()` | `id` (required) | Full task details + markdown body |
| `deps` | `graph.dependencies()` | `id` (required) | Prerequisite task list |
| `dependents` | `graph.dependents()` | `id` (required) | Dependent task list |
| `topo` | `graph.topologicalOrder()` | — | Ordered task list |
| `cycles` | `graph.findCycles()` | — | Cycle report or "no cycles" |
| `validate` | `graph.validate()` | — | Validation errors or "all valid" |

### Analysis Operations

| Operation | Maps to | Key Args | Output |
|-----------|---------|----------|--------|
| `critical` | `criticalPath()`, `weightedCriticalPath()` | — | Critical path with task names |
| `parallel` | `parallelGroups()` | — | Grouped task lists by generation |
| `bottleneck` | `bottlenecks()` | — | Ranked task list with scores |
| `risk` | `riskPath()`, `riskDistribution()` | — | Highest-risk path + distribution table |
| `cost` | `workflowCost()` | `propagationMode`, `defaultQualityRetention`, `includeCompleted` | Per-task EV + totals |
| `decompose` | `shouldDecomposeTask()` | `id` (required) | Decomposition verdict + reasons |

### Help Operation

`tasks({tool: "help"})` returns the full operation reference table. `tasks({tool: "help", args: {tool: "list"}})` returns detailed usage for one operation including argument shapes and example calls.

## Design Decisions

### D1: Registry Pattern (single tool, not 14)

- **Context**: 14 operations could each be a separate tool or collapsed into one router.
- **Choice**: Single `tasks` tool with `{tool, args}` dispatch.
- **Consequences**: Agent always has access to the help reference. Adding operations never increases context bloat. Trade-off: the `tool` and `args` fields are not individually validated by the outer schema — validation happens inside the dispatch.
- **Reference**: See [ADR-001](decisions/001-registry-pattern.md)

### D2: No Caching, Fresh Graph Per Call

- **Context**: Task files change as agents work (status updates, new tasks, removed tasks). A cached graph would become stale.
- **Choice**: Each tool invocation reads the tasks directory fresh and builds a new graph.
- **Consequences**: Slightly redundant I/O for consecutive calls, but guarantees correctness. The tasks directory is typically small (<50 files). The `parseTaskDirectory` + `TaskGraph.fromTasks` pipeline is fast (sub-second for typical task sets).
- **Reference**: See [ADR-002](decisions/002-no-cache.md)

### D3: `risk` Operation Merges `risk-path` and Risk Distribution

- **Context**: The CLI has separate `risk` (distribution) and `risk-path` (path) subcommands. Both are risk-related and an agent asking "what's the risk situation?" wants both.
- **Choice**: Single `risk` operation returns both risk distribution (grouped by category) and risk path (the highest-cumulative-risk path through the DAG).
- **Consequences**: One call gives the full risk picture. Saves the agent from needing two calls and correlating results.
- **Reference**: See [ADR-003](decisions/003-risk-merge.md)

### D4: `decompose` Takes Task ID, Not Raw Attributes

- **Context**: `shouldDecomposeTask()` in the core library accepts `TaskGraphNodeAttributes` directly (an object with id, name, risk, scope, impact, etc. — all categorical fields nullable). The plugin could expose this raw or resolve by task ID.
- **Choice**: The `decompose` operation takes a task `id`, looks up the task from the graph (`graph.getTask(id)`), and passes its attributes to `shouldDecomposeTask()`.
- **Consequences**: Agent-friendly — just pass the task ID rather than reconstructing attributes. If the task doesn't exist, a clear error is returned. The library function is still available for programmatic use; this is an interface convenience.

### D5: `cost` Defaults Match SDD Process

- **Context**: `workflowCost()` supports `propagationMode` (independent vs dag-propagate), `defaultQualityRetention`, and `includeCompleted`. Different defaults make sense for different workflows.
- **Choice**: Default to `propagationMode: "dag-propagate"`, `includeCompleted: false`, `defaultQualityRetention: 0.9` — matching the Spec-Driven Development (SDD) process's assumption that completed tasks are factored out of remaining cost, and that quality degrades probabilistically across dependencies. See [SDD Process](../../sdd_process.md) for the overall workflow.
- **Consequences**: The most common use case (active project planning) gets sensible defaults. Agents can override per-call.

### D6: Separate `registry.ts` From `tools.ts`

- **Context**: Open-memory puts all handler logic in `tools.ts` (~500 lines). That works for a single cohesive domain (SQL queries) but open-tasks has 14 operations that each wrap a distinct library function.
- **Choice**: `tools.ts` defines the tool schema and dispatch. `registry.ts` maps operation names to handler functions. Each operation is a separate file under `operations/`.
- **Consequences**: Each operation is independently understandable and testable. Adding a new operation means adding one file and one registry entry, not editing a growing monolith.

## Interfaces

### Plugin Entry (`src/index.ts`)

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { createTools } from "./tools.js"

const OpenTasksPlugin: Plugin = async (ctx) => {
  return {
    tool: createTools(ctx),
  }
}

export default OpenTasksPlugin
```

No hooks in v1. Future: task status injection into system prompt (similar to open-memory's context awareness hook).

### Tool Definition (`src/tools.ts`)

Single tool with `{tool: string, args?: Record<string, unknown>}` schema. The `tool` field dispatches to an operation handler via the registry. Unknown tool names produce a friendly error directing to `tasks({tool: "help"})`.

### Operation Handler Signature

```typescript
import type { PluginInput } from "@opencode-ai/plugin"

type OperationHandler = (
  args: Record<string, unknown>,
  ctx: PluginInput,
) => string | Promise<string>
```

Each handler receives raw args (already validated by the handler itself) and the plugin context. `PluginInput` provides workspace path information needed by `resolveTasksPath()`. Returns formatted markdown string.

`resolveTasksPath(ctx)` in the registry handles path resolution and returns the absolute path to the tasks directory. Operations should call this rather than hardcoding paths.

## Compatibility Surface

This plugin depends on `@alkdev/taskgraph` for all graph and parsing operations. Any contract divergence between the library and existing task files surfaces as a runtime issue in the plugin — and these are easy to miss until they break.

**Resolved**: The Rust CLI uses `depends_on` (snake_case) in YAML frontmatter while the TypeScript library uses `dependsOn` (camelCase). This was a bug in the library's parser — `parseFrontmatter()` would silently strip `depends_on` and then fail on the missing required field. **Fixed in `@alkdev/taskgraph` v0.0.2**: a normalization step now maps `depends_on` → `dependsOn` before schema validation, so both forms are accepted transparently. See [ADR-004](decisions/004-frontmatter-field-normalization.md).

The broader lesson remains: **issues upstream increase the surface area of issues downstream**. A naming convention in the Rust tooling created a fault line that propagated to every consumer. These are the corners that are hard to see around in linear text — exactly what DAG-structured task analysis is designed to surface.

## Constraints

1. **Read-only** — the plugin never writes to the filesystem. Task mutations happen through Write/Edit tools.
2. **No network** — the plugin makes no HTTP calls. All data comes from local task files.
3. **No state between calls** — each invocation is independent. No caching, no session storage.
4. **Task files are the source of truth** — markdown files in `tasks/` directory. No database, no alternative storage.
5. **Depends on `@alkdev/taskgraph`** — all graph construction, analysis, and frontmatter parsing comes from the core library. This plugin is a thin consumer. Contract changes in the library (field naming, schema changes) propagate here — see [Compatibility Surface](#compatibility-surface).
6. **Task directory required** — operations fail gracefully if no `tasks/` directory is found, returning a clear message about where to create one.
7. **Circular dependency handling** — if `TaskGraph.fromTasks()` detects cycles via the `topologicalOrder()` path, the `cycles` operation surfaces the cycle details. Other operations that rely on topological ordering (topo, critical, parallel, cost) report the error and suggest running `cycles` first.
8. **Frontmatter key normalization resolved** — `@alkdev/taskgraph` v0.0.2+ accepts both `depends_on` and `dependsOn` in YAML frontmatter. The plugin pins `^0.0.2`. See [ADR-004](decisions/004-frontmatter-field-normalization.md) and [Compatibility Surface](#compatibility-surface).

## Error Handling

Operations encounter two categories of errors:

### Infrastructure Errors (tasks directory / file I/O)

- **No tasks directory**: Return a clear message identifying the searched paths and how to create a `tasks/` directory
- **Empty tasks directory**: Return "No task files found in `<path>`"
- **Malformed task file**: Include the filename and parse error in the output. Other valid files are still processed — a single bad file does not block the entire operation
- **File permission errors**: Return the OS error with the file path. Operation continues processing remaining files

### Graph Errors (validation / cycles)

- **Cycle detection**: The `cycles` operation surfaces all cycles. Operations that require topological ordering (topo, critical, parallel, cost) catch `CircularDependencyError` and return a message suggesting `tasks({tool: "cycles"})` first
- **Validation errors**: The `validate` operation returns both schema errors (field-level: invalid enums, missing required fields) and graph errors (dangling references, duplicate edges). Other operations call `graph.validate()` only when structural correctness matters
- **Task not found**: Operations that take a task `id` return a clear "not found" message listing the available task IDs (up to 20)

### Error Format

All errors are returned as markdown-formatted strings (not thrown). The agent sees a helpful message, not a stack trace. This matches open-memory's pattern where every handler returns a string.

## Performance Budget

Each operation should complete within these targets (assumes ≤50 task files):

| Operation | Target | Reasoning |
|-----------|--------|-----------|
| `help`, `list`, `show`, `deps`, `dependents` | <200ms | Single-pass read + format |
| `validate`, `topo`, `cycles` | <300ms | Graph construction + traversal |
| `critical`, `parallel`, `bottleneck` | <400ms | Graph construction + analysis |
| `risk`, `cost` | <500ms | Graph construction + cost-benefit analysis |
| `decompose` | <200ms | Single task lookup + check |

At 100+ files, expect 2-3x slowdown. The dominant cost is file I/O (reading and parsing YAML), not graph algorithms.

## Versioning

The plugin pins `@alkdev/taskgraph` at `^0.0.2` in `package.json` dependencies. As the library stabilizes, the pin should be tightened to a minor version range to prevent unexpected contract changes. Major version bumps in the library require explicit review of this plugin's compatibility surface.

## Operation Lifecycle

New operations can be added freely — the registry pattern means no schema bloat. When an operation needs removal:

1. Mark as deprecated in the `help` text for one minor version
2. Return a deprecation notice from the handler for one minor version
3. Remove in the next major version
4. Any removal requires an ADR documenting the reason

## Test Strategy

- **Unit tests**: Each operation handler tested with mock `TaskGraph` inputs (no file I/O). `@alkdev/taskgraph` functions are mocked — we test formatting and dispatch, not the library's analysis.
- **Integration tests**: End-to-end tool dispatch with a fixture `tasks/` directory containing sample task files. Tests write temporary files, invoke operations, and assert on markdown output.
- **Error tests**: Missing `tasks/` directory, malformed YAML, cyclic graphs, missing task IDs — each error path has at least one test.
- Run with `bun test`. Test fixtures live in `test/fixtures/tasks/`.

## Formatting Conventions

- **Tables** for list, cost, bottleneck — pipe-delimited columns, sorted by relevance
- **Hierarchical lists** for deps, dependents — indented dependency chains
- **Sectioned output** for risk — distribution table followed by risk path
- **Header + detail** for show — frontmatter fields as labeled list, then markdown body
- **Status badges** for validate — ✓ valid / ✗ with error details
- **Grouped output** for parallel — numbered generations with task lists

## Relationship to Other Plugins

| Plugin | Relationship |
|--------|-------------|
| **open-memory** | Complementary — memory handles session introspection; tasks handles task graph analysis. Both use the registry pattern. |
| **open-coordinator** | Downstream consumer — coordinator uses `tasks` to identify parallelizable work, then spawns worktrees. The `parallel` and `critical` operations inform coordination decisions. |
| **taskgraph CLI** | Functional equivalent — the Rust CLI and this plugin expose the same operations, but this plugin is native TypeScript + in-process, while the CLI is a separate binary. |
| **@alkdev/taskgraph** | Core dependency — all graph operations. This plugin is a thin wrapper. |

## Open Questions

1. **Should `show` include the task's markdown body?** Task files can be long (especially with acceptance criteria and notes). Option A: always include full body. Option B: `show` returns frontmatter summary, `show --full` includes body. Recommendation: always include body — agents need the full context for implementation tasks, and `show` is on-demand (not in every call).

2. **Should `cost` accept `--format json`?** The CLI supports JSON output for programmatic consumption. Since the plugin returns to an agent (not a script), markdown is always appropriate. JSON output is out of scope.

3. **Future hook: task status injection?** Open-memory injects context percentage into the system prompt. Could open-tasks inject a brief task summary ("3 pending, 1 in-progress, 2 blocked")? This would require reading tasks on every message, which is cheap for small task sets but could be noisy. Defer to v2.

## References

- `@alkdev/taskgraph` API surface: see [`@alkdev/taskgraph` docs/architecture/api-surface.md](https://git.alk.dev/alkdev/taskgraph_ts) or the local clone at `/workspace/@alkdev/taskgraph_ts/docs/architecture/api-surface.md`
- `@alkdev/taskgraph` README: local clone at `/workspace/@alkdev/taskgraph_ts/README.md`
- open-memory architecture: `/workspace/@alkdev/open-memory/docs/architecture.md` (reference implementation for the registry pattern)
- open-memory tools.ts: `/workspace/@alkdev/open-memory/src/tools.ts` (reference for handler pattern)
- SDD process: [../sdd_process.md](../sdd_process.md)
- OpenCode plugin SDK: `@opencode-ai/plugin` npm package