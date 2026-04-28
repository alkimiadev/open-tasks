---
status: draft
last_updated: 2026-04-28
---

# ADR-001: Registry Pattern (Single Tool Dispatch)

## Context

The plugin exposes 14 distinct operations (list, show, deps, dependents, validate, topo, cycles, critical, parallel, bottleneck, risk, cost, decompose, help). OpenCode's tool system adds each tool's JSON schema to the system prompt. At ~200-300 tokens per tool definition, 14 individual tools would consume ~3500 tokens of context before the agent even starts working.

## Decision

Collapse all operations into a single `taskgraph` tool that dispatches by `{op, args}`. The agent calls `taskgraph({op: "help"})` to discover available operations on demand.

The dispatch field is named `op` (operation) rather than `tool` to avoid collision with OpenCode's own "tool" terminology. An agent calling `taskgraph({op: "list"})` reads clearly: "run the list operation on the taskgraph." This also matches the Rust CLI's subcommand pattern (`taskgraph parallel`, `taskgraph critical`).

This follows the pattern established by open-memory, which exposes 9 operations through a single `memory` tool.

## Consequences

**Positive:**
- Minimal context overhead (~250 tokens for one tool schema vs ~3500 for 14)
- Adding new operations never increases context bloat
- Agent always has access to the full operation set without schema pollution
- Consistent with the alk.dev ecosystem pattern (memory, coordinator both use this)
- `op` field name is unambiguous in OpenCode's context

**Negative:**
- The `op` and `args` fields are not individually validated by the outer schema — validation happens inside the dispatch handler
- Agent must call help to discover operations; the tool description can only hint
- Slightly more overhead per call (string dispatch vs direct function call)

**Mitigation for negatives:**
- The `op` field description enumerates all operation names, so the LLM can dispatch correctly
- Validation errors are clear and include usage guidance
- The help operation provides complete reference with examples

## Note on Schema Libraries

The tool's outer parameter schema uses **Zod** (from `@opencode-ai/plugin`'s `tool()` helper) because that's what OpenCode's plugin SDK provides for tool definitions. The plugin's internal config schema uses **TypeBox** (from `@alkdev/typebox`, already a dependency via `@alkdev/taskgraph`) for compile-time types and runtime `Value.Check()`. These are two different concerns: Zod for OpenCode's tool interface, TypeBox for our own config. No conflict — each is used where it's the native choice.

## References

- open-memory `src/tools.ts`: proven pattern in production
- OpenCode plugin SDK: `tool.schema` (Zod) for tool parameter schemas
- ADR-007: naming decision — `taskgraph` not `tasks`, `op` not `tool`