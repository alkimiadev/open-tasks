# AGENTS.md

## Project

`@alkdev/open-tasks` — an OpenCode plugin that gives agents structured task management with graph analysis, decomposition guidance, and workflow cost estimation. Exposes a single `taskgraph` tool using a registry pattern (like open-memory and open-coordinator) to keep the agent's visible tool count minimal.

Part of the alk.dev trio:
- **open-memory** (`memory` / `memory_compact`): session introspection, context awareness, history browsing
- **open-coordinator** (`worktree`): git worktree orchestration, session spawning, anomaly detection
- **open-tasks** (`taskgraph`): task graph analysis, dependency insight, decomposition guidance

## Repository

- **Git**: `git@git.alk.dev:alkdev/open-tasks.git`
- **License**: MIT OR Apache-2.0
- **Runtime**: Bun
- **Language**: TypeScript (strict, ESM, verbatimModuleSyntax)
- **Linter**: Biome (`bun run lint`, `bun run format`)
- **Build**: `bun run build` → `dist/` (bun build + tsc declarations)

## Commands

```bash
bun run build        # bun build src/index.ts + tsc --emitDeclarationOnly
bun run typecheck    # tsc --noEmit
bun run lint         # biome check .
bun run format       # biome format --write .
bun run test         # bun test
```

**Always run** `bun run typecheck` and `bun run lint` after changes.

## Architecture

### Core Dependency: @alkdev/taskgraph

The graph operations, risk scoring, frontmatter parsing, and analysis functions come from `@alkdev/taskgraph` — a pure TypeScript library built on graphology. This plugin wraps that library in an OpenCode tool interface.

Key imports from `@alkdev/taskgraph`:
- `TaskGraph` — primary graph data structure (construction, queries, mutation, export)
- `parseFrontmatter`, `serializeFrontmatter` — YAML frontmatter I/O (we use `parseFrontmatter` directly; directory scanning uses Bun.Glob per ADR-006)
- `criticalPath`, `weightedCriticalPath`, `parallelGroups`, `bottlenecks` — analysis functions
- `riskPath`, `riskDistribution`, `calculateTaskEv`, `workflowCost` — risk & cost analysis
- `shouldDecomposeTask` — decomposition guidance
- Categorical types: `TaskScope`, `TaskRisk`, `TaskImpact`, `TaskLevel`, `TaskPriority`, `TaskStatus`

### Plugin Design: Registry Pattern

Like open-memory, this plugin exposes **one tool** (`taskgraph`) with internal operation dispatch. This keeps the agent's visible tool count low.

```
taskgraph({op: "help"})                         → Show available operations
taskgraph({op: "list"})                         → List tasks in project
taskgraph({op: "show", args: {id: "..."}})      → Show task details
taskgraph({op: "deps", args: {id: "..."}})      → Show task prerequisites
taskgraph({op: "dependents", args: {id: "..."}}) → Show tasks that depend on a task
taskgraph({op: "validate"})                      → Validate all task files
... etc
```

The dispatch field is `op` (operation) rather than `tool` — this avoids confusion with OpenCode's "tool" concept and matches the Rust CLI's subcommand pattern (`taskgraph parallel`, `taskgraph critical`).

### Source Structure

```
src/
├── index.ts              # Plugin entry: config resolution + tool registration
├── tools.ts              # Tool definitions (taskgraph router)
├── registry.ts           # Operation registry pattern (dispatch by tool name)
├── config.ts             # Plugin config schema (TypeBox, validated)
├── sources/
│   ├── types.ts          # TaskSource interface, SourceResult, SourceError
│   ├── file-source.ts    # FileSource — reads tasks/ via Bun.Glob + parseFrontmatter
│   └── index.ts          # Source factory: resolves config → TaskSource
├── operations/            # Individual operation implementations
│   ├── help.ts
│   ├── list.ts
│   ├── show.ts
│   ├── deps.ts
│   ├── dependents.ts
│   ├── validate.ts
│   ├── topo.ts
│   ├── cycles.ts
│   ├── critical.ts
│   ├── parallel.ts
│   ├── bottleneck.ts
│   ├── risk.ts
│   ├── cost.ts
│   └── decompose.ts
└── formatting.ts          # Output formatting helpers
```

### Plugin Hooks

| Hook | Purpose |
|------|---------|
| None initial — future: task status injection into system prompt, worktree-aware task context |

### The `taskgraph` Tool

Operations map to `@alkdev/taskgraph` functions, reading tasks from a `TaskSource` (v1: `FileSource` via `Bun.Glob` + `parseFrontmatter`) and returning formatted output.

## Plugin Config

Optional config via `opencode.json`. OpenCode passes the raw options object to the plugin — the plugin validates with TypeBox at startup.

```jsonc
// No config = default FileSource("tasks"), silent if directory missing
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

// Future: API source (secrets via env vars, not config)
// {
//   "plugin": [
//     ["@alkdev/open-tasks", {
//       "source": { "type": "api", "url": "https://api.example.com/tasks" }
//     }]
//   ]
// }
```

The `source.type` field is a discriminated union — each source type has its own config shape. Defaults to `{ type: "file", tasksPath: "tasks" }` if no config is provided. Secrets (API keys) come from environment variables, not config files.

## Local Development & Testing

OpenCode installs plugins from npm into `~/.cache/opencode/node_modules/`. When doing local development, symlink your local repo:

### Setup (one-time)

```bash
rm -rf ~/.cache/opencode/node_modules/@alkdev/open-tasks
ln -s /workspace/@alkdev/open-tasks ~/.cache/opencode/node_modules/@alkdev/open-tasks
```

### Iteration loop

```bash
bun run build          # rebuild dist/index.js
bun run typecheck      # verify types
bun run lint           # verify style
bun run test           # run tests
```

After rebuilding, restart OpenCode to pick up the new build.

### Also clear Bun's global cache

```bash
rm -rf ~/.bun/install/cache/@alkdev/open-tasks*
```

## Key Conventions

- No comments unless requested
- ESM with `.js` extension in imports
- Strict TypeScript with `verbatimModuleSyntax`
- Biome for linting and formatting
- Task files are the source of truth (markdown with YAML frontmatter)
- Single tool with registry dispatch — minimize agent context bloat
- Include a `help` operation for discoverability

## Relationship to Other Plugins

- **open-memory** (`memory`, `memory_compact`): session history, context awareness — complementary
- **open-coordinator** (`worktree`): worktree orchestration — tasks drive what worktrees implement
- **taskgraph CLI** (`taskgraph`): Rust CLI for the same operations — this plugin is the TypeScript/OpenCode equivalent
- **@alkdev/taskgraph** (npm): Core library this plugin wraps — all graph operations come from here

## Task File Format

Tasks are markdown files in `tasks/` with YAML frontmatter:

```yaml
---
id: auth-setup
name: Setup Authentication
status: pending
dependsOn: []
scope: moderate
risk: medium
impact: component
level: implementation
---

## Description

Implement OAuth2 authentication with provider abstraction.

## Acceptance Criteria

- [ ] OAuth2 flow works with Google provider
- [ ] Tokens stored securely

## Notes

> Agent fills this during implementation.

## Summary

> Agent fills this on completion.
```

> **Note on field naming**: The `@alkdev/taskgraph` library uses camelCase (`dependsOn`, `scope`, `risk`, etc.) in its schema. The Rust CLI historically used snake_case (`depends_on`). As of `@alkdev/taskgraph` v0.0.2, the parser accepts both forms — but camelCase is the canonical form for new files.

## Build & Test Commands

```bash
bun run build          # bun build src/index.ts + tsc declarations
bun run typecheck      # tsc --noEmit
bun run lint           # biome check .
bun run format         # biome format --write .
bun run test           # bun test
```

## License

Dual-licensed under MIT OR Apache-2.0. Both license files must be present at repository root.