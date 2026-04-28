---
status: draft
last_updated: 2026-04-28
---

# Open Tasks: Architecture Overview

Structured task management for OpenCode agents — graph analysis, dependency insight, decomposition guidance, and workflow cost estimation. Exposes a single `taskgraph` tool using a registry pattern to keep the agent's visible tool count minimal.

## Problem

The `taskgraph` Rust CLI provides task graph operations but requires shell invocation — agents must compose bash commands and parse plain-text output. This is error-prone, context-expensive, and gives no structural validation or rich formatting. The TypeScript core library (`@alkdev/taskgraph`) now provides all graph operations natively. This plugin wraps that library into an OpenCode tool interface so agents get first-class, structured access without leaving the conversation.

## Naming: `taskgraph` not `tasks`

OpenCode has a built-in `task` tool that spawns subagents for work delegation. Naming our plugin `tasks` (plural) would create confusion — both deal with "tasks" but have completely different purposes:

| Tool | Concept | Scope |
|------|---------|-------|
| `task` (built-in) | **Delegation** — spawn a subagent to do work | Session-scoped, ephemeral |
| `todowrite` (built-in) | **Progress tracking** — what am I working on now | Session-scoped, flat list |
| `taskgraph` (this plugin) | **Analysis** — what work exists, what depends on what, what's risky | Persistent, graph-structured |

The name `taskgraph` directly matches the core library, clearly differentiates from the built-in `task`, and describes what the tool actually does. See [ADR-007](decisions/007-naming-taskgraph.md).

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

Following open-memory's proven approach, the plugin exposes **one tool** (`taskgraph`) with internal operation dispatch:

```
taskgraph({op: "help"})                         → Show available operations
taskgraph({op: "list"})                         → List tasks in project
taskgraph({op: "show", args: {id: "..."}})      → Show task details
taskgraph({op: "deps", args: {id: "..."}})      → Task prerequisites
taskgraph({op: "dependents", args: {id: "..."}}) → Tasks depending on a task
taskgraph({op: "validate"})                      → Validate all task files
taskgraph({op: "topo"})                          → Topological ordering
taskgraph({op: "cycles"})                        → Circular dependency detection
taskgraph({op: "critical"})                      → Critical path
taskgraph({op: "parallel"})                      → Parallel execution groups
taskgraph({op: "bottleneck"})                  → Bottleneck analysis
taskgraph({op: "risk"})                           → Risk path + distribution
taskgraph({op: "cost"})                           → Workflow cost estimate
taskgraph({op: "decompose", args: {id: "..."}})  → Decomposition guidance
```

**Why**: Each tool definition adds JSON schema to the system prompt (~200-300 tokens each). 14 operations as 14 separate tools = ~3500 tokens of tool definitions. The registry pattern collapses this to ~250 tokens (one tool schema) plus an on-demand help text the agent retrieves only when needed. This is the same math that drove open-memory's design.

**Why `op` instead of `tool`**: The dispatch field is named `op` (operation) rather than `tool` to avoid collision with OpenCode's own "tool" terminology. An agent calling `taskgraph({tool: "list"})` reads ambiguously — is "list" a tool or an operation on the taskgraph tool? `taskgraph({op: "list"})` is clearer: "run the list operation on the taskgraph."

### Component Structure

```
src/
├── index.ts              # Plugin entry: tool registration + config loading
├── tools.ts              # Tool definition — single `taskgraph` tool with registry dispatch
├── registry.ts           # Operation registry (dispatch table, arg validation)
├── config.ts             # Plugin config schema + resolution (TypeBox, validated)
├── sources/
│   ├── types.ts          # TaskSource interface
│   ├── file-source.ts    # FileSource — reads tasks/ directory via Bun.Glob + parseFrontmatter
│   └── index.ts          # Source factory: resolves config → TaskSource
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

### Plugin Configuration

OpenCode passes plugin options as a raw `Record<string, unknown>` directly from the `opencode.json` config tuple. There is no OpenCode-side validation — the plugin receives exactly what was in the config file. This means:

- The plugin validates its own config using TypeBox + `Value.Check()` at startup
- Invalid config produces a clear error and falls back to defaults
- No extra config files needed — everything lives in `opencode.json`

```jsonc
// No config = default FileSource("tasks"), do nothing if directory doesn't exist
{
  "plugin": ["@alkdev/open-tasks"]
}

// Explicit file source with custom path
{
  "plugin": [
    ["@alkdev/open-tasks", {
      "source": { "type": "file", "tasksPath": "docs/tasks" }
    }]
  ]
}

// Future example: API source (secrets via env vars, not config)
// {
//   "plugin": [
//     ["@alkdev/open-tasks", {
//       "source": { "type": "api", "url": "https://api.example.com/tasks" }
//     }]
//   ]
// }
```

### Config Behavior

- **No config or no `source` key** → FileSource with `tasksPath: "tasks"`. If the directory doesn't exist, operations return an empty/graceful result rather than an error. The plugin does nothing silently — no crash, no noise.
- **`source` provided** → Factory resolves `source.type` to the matching TaskSource implementation. Unknown types produce a clear error at startup.
- **Secrets** (future API keys, tokens) are never stored in config files (which are committed to git). They come from environment variables at runtime (e.g., `TASKGRAPH_API_KEY`). Config holds only non-sensitive connection parameters (URLs, paths).

The `source.type` field is a discriminated union key. Each source type has its own config shape — one type, one set of properties. This avoids the flat "add more keys" anti-pattern where every new source type adds nullable fields to a growing config object.

### Config Schema

```typescript
import { Type, type Static, Union, Literal, Object, String, Optional } from "@alkdev/typebox"

const FileSourceConfig = Type.Object({
  type: Type.Literal("file"),
  tasksPath: Type.Optional(Type.String({ default: "tasks", description: "Relative to workspace root" })),
})

const ApiSourceConfig = Type.Object({
  type: Type.Literal("api"),
  url: Type.String({ description: "Endpoint URL" }),
  // API keys read from env vars: TASKGRAPH_API_KEY
  // Not stored in config (committed to git)
})

export const SourceConfigSchema = Type.Union([FileSourceConfig, ApiSourceConfig])

export const ConfigSchema = Type.Object({
  source: Type.Optional(SourceConfigSchema),  // defaults to FileSource("tasks")
})

export type Config = Static<typeof ConfigSchema>
export type SourceConfig = Static<typeof SourceConfigSchema>
```

TypeBox gives us:
- **Compile-time types** — `Static<typeof ConfigSchema>` for TypeScript inference, discriminated union on `source.type`
- **Runtime validation** — `Value.Check(ConfigSchema, configObj)` rejects invalid config at startup
- **JSON Schema export** — `Value.Convert()` applies defaults, IDE autocomplete via `$schema`

### TaskSource Abstraction

Operations don't read the filesystem directly. They go through a `TaskSource` interface:

```typescript
interface TaskSource {
  /** Human-readable description for error messages */
  readonly name: string

  /** Load all tasks, returning parsed TaskInput[] and raw file data */
  load(): Promise<SourceResult>
}

interface SourceResult {
  tasks: TaskInput[]           // parsed frontmatter from @alkdev/taskgraph
  rawFiles: Map<string, string> // taskId → full file content (for `show` operation)
  errors: SourceError[]         // files that failed to parse
}

interface SourceError {
  filePath: string
  error: string
}
```

**Why an interface?** v1 only has `FileSource` (reads from `tasks/` directory). But the abstraction makes it trivial to add:

- **ApiSource** — tasks fetched from a remote endpoint (future: project management tools, CI dashboards)
- **MixedSource** — merge multiple sources with precedence rules
- **TestSource** — in-memory tasks for unit testing operations without filesystem

Each source implements `load()` and returns the same shape. Operations receive a `SourceResult` and work with it — they never know (or care) where the data came from. This is the same pattern that makes the `tool` tool in open-memory work with SQLite but be testable with in-memory data.

### FileSource Implementation

The v1 concrete source reads markdown files from a directory:

```typescript
class FileSource implements TaskSource {
  readonly name: string

  constructor(private dirPath: string) {
    this.name = `FileSource(${dirPath})`
  }

  async load(): Promise<SourceResult> {
    // If directory doesn't exist, return empty result (not an error)
    if (!existsSync(this.dirPath)) {
      return { tasks: [], rawFiles: new Map(), errors: [] }
    }

    const glob = new Bun.Glob("**/*.md")
    const files = await Array.fromAsync(glob.scan({ cwd: this.dirPath }))
    // ... read each file, parse with parseFrontmatter, collect results
  }
}
```

**Key behavior**: if the configured directory doesn't exist, `FileSource.load()` returns an empty `SourceResult` — no crash, no error. Operations that receive an empty task set produce a clear message ("No tasks found in `<path>`. Create a `tasks/` directory..."). This means the plugin is safe to install without setting anything up — it just does nothing until task files appear.

**Path resolution** for FileSource:

1. **Config `tasksPath`** — if provided, treated as relative to workspace root (from `ctx.directory` in `PluginInput`). Path traversal (`../../etc/`) is rejected.
2. **Default** — `"tasks"` relative to workspace root.
3. **Directory missing** — returns empty result, operations explain how to create one.

No CWD fallback. The workspace root from the OpenCode plugin context is the authoritative base path.

### Source Factory

```typescript
function createSource(config: Config, workspaceDir: string): TaskSource {
  switch (config.source?.type) {
    case "file":
    case undefined:  // default
      return new FileSource(resolve(workspaceDir, config.source?.tasksPath ?? "tasks"))
    case "api":
      return new ApiSource(config.source)  // future
    default:
      throw new Error(`Unknown source type: ${config.source?.type}`)
  }
}
```

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

`taskgraph({op: "help"})` returns the full operation reference table. `taskgraph({op: "help", args: {op: "list"}})` returns detailed usage for one operation including argument shapes and example calls.

## Design Decisions

### D1: Registry Pattern (single tool, not 14)

- **Context**: 14 operations could each be a separate tool or collapsed into one router.
- **Choice**: Single `taskgraph` tool with `{op, args}` dispatch.
- **Consequences**: Agent always has access to the help reference. Adding operations never increases context bloat. Trade-off: the `op` and `args` fields are not individually validated by the outer schema — validation happens inside the dispatch.
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
- **Choice**: Default to `propagationMode: "dag-propagate"`, `includeCompleted: false`, `defaultQualityRetention: 0.9` — matching the Spec-Driven Development (SDD) process's assumption that completed tasks are factored out of remaining cost, and that quality degrades probabilistically across dependencies. See [SDD Process](../sdd_process.md) for the overall workflow.
- **Consequences**: The most common use case (active project planning) gets sensible defaults. Agents can override per-call.

### D6: Separate `registry.ts` From `tools.ts`

- **Context**: Open-memory puts all handler logic in `tools.ts` (~500 lines). That works for a single cohesive domain (SQL queries) but open-tasks has 14 operations that each wrap a distinct library function.
- **Choice**: `tools.ts` defines the tool schema and dispatch. `registry.ts` maps operation names to handler functions. Each operation is a separate file under `operations/`.
- **Consequences**: Each operation is independently understandable and testable. Adding a new operation means adding one file and one registry entry, not editing a growing monolith.

### D7: TaskSource Abstraction

- **Context**: v1 reads tasks from a local `tasks/` directory. Future sources could include API endpoints, databases, or remote project management tools. Hardcoding file I/O in each operation would make this evolution painful.
- **Choice**: Define a `TaskSource` interface with a single `load()` method returning `SourceResult { tasks, rawFiles, errors }`. v1 implements `FileSource` (reads from filesystem). The source is resolved once at plugin initialization and passed to all operations.
- **Consequences**: Operations are decoupled from I/O. `FileSource` uses `Bun.Glob` for discovery and `parseFrontmatter` for parsing. Future `ApiSource` would swap in a fetch call. Test sources can provide in-memory data. The `show` operation gets raw file content via `rawFiles` — no second I/O pass needed.

### D8: Bun.Glob Over `parseTaskDirectory`

- **Context**: `@alkdev/taskgraph` provides `parseTaskFile` and `parseTaskDirectory` for file I/O. However, `parseTaskDirectory` silently skips invalid files and returns only `TaskInput[]` — no raw content, no error detail.
- **Choice**: Use `Bun.Glob("**/*.md")` for directory scanning, `Bun.file()` for reading, and `parseFrontmatter()` (singular) for parsing. The `show` operation needs full markdown content (not just frontmatter), and `validate` needs to report filenames with errors.
- **Consequences**: Single I/O pass per call. We get raw file content for `show`, error detail for `validate`, and the same `parseFrontmatter` parsing we'd get from the library. The library is still the dependency for `parseFrontmatter`, `TaskGraph`, and all analysis — we just don't use its directory-scanning convenience function.

## Interfaces

### Plugin Entry (`src/index.ts`)

```typescript
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { Value } from "@alkdev/typebox/value"
import { ConfigSchema, type Config } from "./config.js"
import { createSource } from "./sources/index.js"
import { createTools } from "./tools.js"

const OpenTasksPlugin: Plugin = async (ctx, options) => {
  const config = resolveConfig(options)
  const source = createSource(config, ctx.directory)

  return {
    tool: createTools(ctx, source),
  }
}

// OpenCode passes the raw JSON object from opencode.json as PluginOptions.
// It's Record<string, unknown> — untyped. We validate with TypeBox and apply defaults.
function resolveConfig(options?: PluginOptions): Config {
  if (options && Object.keys(options).length > 0) {
    // Validate against our schema. If invalid, log a warning and fall back to defaults.
    if (!Value.Check(ConfigSchema, options)) {
      console.warn("@alkdev/open-tasks: invalid config, using defaults", {
        errors: [...Value.Errors(ConfigSchema, options)],
      })
      return { source: { type: "file", tasksPath: "tasks" } }
    }
    return Value.Cast(ConfigSchema, options) as Config
  }
  return { source: { type: "file", tasksPath: "tasks" } }
}

export default OpenTasksPlugin
```

No hooks in v1. Future: task status injection into system prompt (similar to open-memory's context awareness hook).

### Tool Definition (`src/tools.ts`)

Single tool with `{op: string, args?: Record<string, unknown>}` schema. The `op` field dispatches to an operation handler via the registry. Unknown operation names produce a friendly error directing to `taskgraph({op: "help"})`.

The tool's parameter schema uses **Zod** (from `@opencode-ai/plugin`'s `tool()` helper) because that's what OpenCode's plugin SDK provides for tool definitions. The plugin's internal config schema uses **TypeBox** for compile-time types and runtime `Value.Check()`. These are two different concerns: Zod for the tool's external interface (what the LLM sees), TypeBox for our own config (what we validate at startup).

The `source` is passed from the plugin entry to `createTools()` and stored in the registry for all operations to use.

### Operation Handler Signature

```typescript
import type { PluginInput } from "@opencode-ai/plugin"
import type { TaskSource } from "./sources/types.js"

type OperationHandler = (
  args: Record<string, unknown>,
  source: TaskSource,
  ctx: PluginInput,
) => string | Promise<string>
```

Each handler receives raw args (validated by the handler itself), the `TaskSource` for loading task data, and the plugin context. `PluginInput` provides `directory` (workspace root) and `worktree` path. Returns formatted markdown string.

## Compatibility Surface

This plugin depends on `@alkdev/taskgraph` for all graph and parsing operations. Any contract divergence between the library and existing task files surfaces as a runtime issue in the plugin — and these are easy to miss until they break.

**Resolved**: The Rust CLI uses `depends_on` (snake_case) in YAML frontmatter while the TypeScript library uses `dependsOn` (camelCase). This was a bug in the library's parser — `parseFrontmatter()` would silently strip `depends_on` and then fail on the missing required field. **Fixed in `@alkdev/taskgraph` v0.0.2**: a normalization step now maps `depends_on` → `dependsOn` before schema validation, so both forms are accepted transparently. See [ADR-004](decisions/004-frontmatter-field-normalization.md).

The broader lesson remains: **issues upstream increase the surface area of issues downstream**. A naming convention in the Rust tooling created a fault line that propagated to every consumer. These are the corners that are hard to see around in linear text — exactly what DAG-structured task analysis is designed to surface.

## Constraints

1. **Read-only** — the plugin never writes to the filesystem. Task mutations happen through Write/Edit tools.
2. **No network in v1** — FileSource reads local files only. The TaskSource abstraction makes future network sources possible but v1 has no ApiSource.
3. **No state between calls** — each invocation is independent. No caching, no session storage.
4. **Task files are the source of truth** — markdown files in `tasks/` directory (or configured path). No database, no alternative storage in v1.
5. **Depends on `@alkdev/taskgraph`** — all graph construction and frontmatter parsing comes from the core library. This plugin provides the I/O layer, config, and formatting. Contract changes in the library (field naming, schema changes) propagate here — see [Compatibility Surface](#compatibility-surface).
6. **Task directory required** — operations fail gracefully if no `tasks/` directory is found, returning a clear message about where to create one.
7. **Circular dependency handling** — if `TaskGraph.fromTasks()` detects cycles via the `topologicalOrder()` path, the `cycles` operation surfaces the cycle details. Other operations that rely on topological ordering (topo, critical, parallel, cost) report the error and suggest running `cycles` first.
8. **Frontmatter key normalization resolved** — `@alkdev/taskgraph` v0.0.2+ accepts both `depends_on` and `dependsOn` in YAML frontmatter. The plugin pins `^0.0.2`. See [ADR-004](decisions/004-frontmatter-field-normalization.md) and [Compatibility Surface](#compatibility-surface).
9. **Operations never touch the filesystem directly** — they go through `TaskSource.load()`. This enforces the read-only constraint and makes operations testable with in-memory sources.

## Error Handling

Operations encounter two categories of errors:

### Infrastructure Errors (tasks directory / file I/O)

- **No tasks directory**: Return a clear message identifying the searched paths and how to create a `tasks/` directory
- **Empty tasks directory**: Return "No task files found in `<path>`"
- **Malformed task file**: Include the filename and parse error in the output. Other valid files are still processed — a single bad file does not block the entire operation
- **File permission errors**: Return the OS error with the file path. Operation continues processing remaining files

### Graph Errors (validation / cycles)

- **Cycle detection**: The `cycles` operation surfaces all cycles. Operations that require topological ordering (topo, critical, parallel, cost) catch `CircularDependencyError` and return a message suggesting `taskgraph({op: "cycles"})` first
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

**Benchmark data** (43 tasks, all analysis functions, Bun runtime):
- Glob scan (`Bun.Glob`): ~1ms
- File read + parse (`parseFrontmatter` per file): ~140ms
- Graph construction (`TaskGraph.fromTasks`): ~5ms
- All six analysis functions combined: ~17ms
- **Total pipeline**: ~150ms

The Rust CLI is faster on raw file I/O and YAML parsing (native binary, no JS overhead), but the plugin wins on overall call latency — no subprocess spawn, no plain-text parsing by the LLM, no context-wasting bash composition. The ~150ms is well within agent tool call budgets.

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
| **open-memory** | Complementary — memory handles session introspection; taskgraph handles task graph analysis. Both use the registry pattern. |
| **open-coordinator** | Future integration — coordinator's `spawn`/`swarm` could consume taskgraph's `parallel` and `critical` analysis for dependency-aware parallel execution. Currently no integration exists. |
| **taskgraph CLI** | Functional equivalent — the Rust CLI and this plugin expose the same operations, but this plugin is native TypeScript + in-process, while the CLI is a separate binary. |
| **@alkdev/taskgraph** | Core dependency — all graph operations. This plugin is a thin wrapper. |
| **`task` (built-in)** | Distinct concept — spawns subagents for work delegation. `taskgraph` analyzes dependencies. Future: `task` could consume `taskgraph` analysis for smarter delegation, but these are complementary, not competing. See [ADR-007](decisions/007-naming-taskgraph.md). |
| **`todowrite` (built-in)** | Complementary — session-scoped flat progress tracking. `taskgraph` operates on persistent graph-structured project files; `todowrite` tracks in-session ephemeral progress. No overlap. |

## Open Questions

1. ~~**Should `show` include the task's markdown body?**~~ **Resolved**: Yes. The `FileSource` provides `rawFiles` in `SourceResult`, and the `show` operation returns the full markdown body. This decision is locked in by the TaskSource design (ADR-005).

2. **Should `cost` accept `--format json`?** The CLI supports JSON output for programmatic consumption. Since the plugin returns to an agent (not a script), markdown is always appropriate. JSON output is out of scope.

3. **Future hook: task status injection?** Open-memory injects context percentage into the system prompt. Could open-tasks inject a brief task summary ("3 pending, 1 in-progress, 2 blocked")? This would require reading tasks on every message, which is cheap for small task sets but could be noisy. Defer to v2.

4. **Future: taskgraph-aware execution?** Open-coordinator's `swarm`/`spawn` operations take arrays of task names but have no dependency awareness. A natural integration would let `taskgraph({op: "parallel"})` feed directly into coordinator's `swarm` — each parallel group becomes a wave of worktrees. Similarly, the built-in `task` tool's prompt could be enriched with dependency context from `taskgraph`. Both are v2+ concerns.

5. **Should `TaskSource.load()` throw or capture errors in `SourceResult.errors`?** Per-file errors (malformed YAML, invalid schema) are captured in `errors`. Infrastructure errors (permission denied on the directory, disk failure) are thrown. This distinction needs to be documented in the `TaskSource` interface contract.

## References

- `@alkdev/taskgraph` API surface: see [`@alkdev/taskgraph` docs/architecture/api-surface.md](https://git.alk.dev/alkdev/taskgraph_ts) or the local clone at `/workspace/@alkdev/taskgraph_ts/docs/architecture/api-surface.md`
- `@alkdev/taskgraph` README: local clone at `/workspace/@alkdev/taskgraph_ts/README.md`
- open-memory architecture: `/workspace/@alkdev/open-memory/docs/architecture.md` (reference implementation for the registry pattern)
- open-memory tools.ts: `/workspace/@alkdev/open-memory/src/tools.ts` (reference for handler pattern)
- OpenCode `task` tool research: [../research/opencode-task-tool-deep-dive.md](../research/opencode-task-tool-deep-dive.md)
- open-coordinator research: [../research/open-coordinator-deep-dive.md](../research/open-coordinator-deep-dive.md)
- SDD process: [../sdd_process.md](../sdd_process.md)
- OpenCode plugin SDK: `@opencode-ai/plugin` npm package