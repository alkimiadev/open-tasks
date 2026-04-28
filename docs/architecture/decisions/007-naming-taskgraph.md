---
status: draft
last_updated: 2026-04-28
---

# ADR-007: Tool Naming — `taskgraph` not `tasks`

## Context

OpenCode has a built-in `task` tool that spawns subagents for work delegation. It creates child sessions, dispatches prompts to specialized agents, and returns results. It is deeply wired into the session, permission, and UI systems.

Our plugin was initially named `tasks` (plural), which creates three problems:

1. **Naming confusion**: `task` (spawning) vs `tasks` (analysis) — both deal with "tasks" but are fundamentally different. An LLM receiving a request like "look at the tasks" might invoke the wrong one.

2. **Semantic overlap**: `task` = delegation ("who should do this work?"), `tasks` = analysis ("what work exists and in what order?"), `todowrite` = progress tracking ("what am I working on right now?"). Three concepts, near-identical naming for two of them.

3. **Plugin shadowing risk**: OpenCode resolves tools into an object by ID. If a plugin registers a tool with the same ID as a built-in tool, the plugin wins. Accidentally shadowing the built-in `task` tool would break subagent spawning entirely.

Additionally, the dispatch field was initially named `tool` (matching open-memory's pattern). But the field name `tool` is ambiguous in OpenCode's context — every registered function is a "tool." The operation name `op` is more precise and matches the Rust CLI's subcommand pattern.

## Decision

- **Tool name**: `taskgraph` — directly matches the core library (`@alkdev/taskgraph`), clearly differentiates from the built-in `task`, and describes what the tool actually does.
- **Dispatch field**: `op` (operation) — unambiguous in context, distinguishes from the outer "tool" concept, matches the Rust CLI's subcommand pattern (`taskgraph parallel`, `taskgraph critical`, etc.).

## Consequences

**Positive:**
- No naming confusion with built-in `task`
- `taskgraph({op: "list"})` reads clearly: "run the list operation on the taskgraph"
- Matches the Rust CLI naming — users familiar with `taskgraph parallel` will recognize `taskgraph({op: "parallel"})`
- The `op` field name is self-documenting: each value is an operation, not a nested tool

**Negative:**
- Slightly longer tool name (10 chars vs 5 for `tasks`)
- Deviates from open-memory's `memory({tool: ...})` pattern — but memory doesn't have a naming collision with a built-in tool

## The Three "Task" Concepts

| Tool | Concept | Scope | Persistence |
|------|---------|-------|-------------|
| `task` (built-in) | Delegation — spawn a subagent | Session-scoped | Ephemeral |
| `todowrite` (built-in) | Progress tracking — what am I working on | Session-scoped | Ephemeral |
| `taskgraph` (this plugin) | Analysis — dependencies, risk, cost | Project-scoped | Persistent files |

These are complementary, not competing. Future integration could make `taskgraph` feed analysis into `task` (e.g., use `parallel` groups to drive `spawn` decisions), but that's a v2 concern.

## References

- OpenCode built-in `task` tool: `/workspace/opencode/packages/opencode/src/tool/task.ts`
- Research report: [docs/research/opencode-task-tool-deep-dive.md](../research/opencode-task-tool-deep-dive.md)
- Open-coordinator deep dive: [docs/research/open-coordinator-deep-dive.md](../research/open-coordinator-deep-dive.md)