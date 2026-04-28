---
status: draft
last_updated: 2026-04-28
---

# ADR-003: Merged `risk` Operation (Risk Path + Risk Distribution)

## Context

The taskgraph CLI exposes two separate risk-related subcommands:
- `taskgraph risk` — shows risk distribution (tasks grouped by risk level: trivial, low, medium, high, critical)
- `taskgraph risk-path` — shows the single highest-cumulative-risk path through the DAG

Both are about understanding risk in the task graph. An agent asking "what's the risk situation?" almost always wants both perspectives — which tasks are risky, and where does risk concentrate along paths.

## Decision

Merge into a single `risk` operation that returns:
1. **Risk distribution** — tasks grouped by risk level (trivial → critical), with counts and percentages
2. **Highest risk path** — the path through the DAG with maximum cumulative risk, showing per-task risk and impact

This maps to `riskDistribution(graph)` and `riskPath(graph)` from `@alkdev/taskgraph`.

## Consequences

**Positive:**
- One call gives the complete risk picture
- Agent doesn't need to correlate results from two separate calls
- The distribution provides context for understanding the risk path (e.g., "3 high-risk tasks, 2 of which are on the critical path")

**Negative:**
- Output is larger than individual calls
- An agent that only wants distribution or only wants the path gets extra content
- Slightly more complex formatting logic

**Mitigation for negatives:**
- The combined output is still well under typical markdown rendering limits
- Distribution is shown first (most likely to be actioned on), path second (deeper analysis)
- Both sections have clear headers so the agent can focus on what matters

## References

- taskgraph CLI: `taskgraph risk` and `taskgraph risk-path` subcommands
- `@alkdev/taskgraph`: `riskDistribution()` and `riskPath()` functions