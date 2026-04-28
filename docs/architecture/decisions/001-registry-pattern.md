---
status: draft
last_updated: 2026-04-28
---

# ADR-001: Registry Pattern (Single Tool Dispatch)

## Context

The plugin exposes 14 distinct operations (list, show, deps, dependents, validate, topo, cycles, critical, parallel, bottleneck, risk, cost, decompose, help). OpenCode's tool system adds each tool's JSON schema to the system prompt. At ~200-300 tokens per tool definition, 14 individual tools would consume ~3500 tokens of context before the agent even starts working.

## Decision

Collapse all operations into a single `tasks` tool that dispatches by `{tool: string, args?: Record<string, unknown>}`. The agent calls `tasks({tool: "help"})` to discover available operations on demand.

This follows the pattern established by open-memory, which exposes 9 operations through a single `memory` tool.

## Consequences

**Positive:**
- Minimal context overhead (~250 tokens for one tool schema vs ~3500 for 14)
- Adding new operations never increases context bloat
- Agent always has access to the full operation set without schema pollution
- Consistent with the alk.dev ecosystem pattern (memory, coordinator all use this)

**Negative:**
- The `tool` and `args` fields are not validated by the outer Zod schema — validation happens inside the dispatch handler
- Agent must call help to discover operations; the tool description can only hint
- Slightly more overhead per call (string dispatch vs direct function call)

**Mitigation for negatives:**
- The `tool` field description enumerates all operation names, so the LLM can dispatch correctly
- Validation errors are clear and include usage guidance
- The help operation provides complete reference with examples

## References

- open-memory `src/tools.ts`: proven pattern in production
- OpenCode plugin SDK: `tool.schema` (Zod) for schema definition