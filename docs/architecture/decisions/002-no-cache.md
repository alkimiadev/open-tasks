---
status: draft
last_updated: 2026-04-28
---

# ADR-002: No Caching — Fresh Graph Per Invocation

## Context

Task files change frequently during active work. Agents update task status (pending → in-progress → completed), add notes, modify acceptance criteria. A cached `TaskGraph` would become stale and produce misleading analysis.

Options considered:
1. **Fresh read per call** — parse files and build graph on every invocation
2. **Session-scoped cache** — cache the graph within a session, invalidate on file change detection
3. **Time-based TTL cache** — cache for N seconds, then re-parse

## Decision

Fresh read per call (Option 1). Each tool invocation reads the tasks directory and constructs a new `TaskGraph`.

## Consequences

**Positive:**
- Guaranteed correctness — analysis always reflects the current state of task files
- No invalidation logic to get wrong
- No cache coherence bugs
- Simple mental model for the agent — "what I see is what's on disk"

**Negative:**
- Redundant I/O for consecutive calls within a short time window
- Slight latency increase for each call

**Why this is acceptable:**
- Typical task directories contain 5-50 files. `parseTaskDirectory` + `TaskGraph.fromTasks` is sub-second for this scale.
- The plugin is read-only — there's no mutation to cache anyway
- File I/O is the plugin's only expensive operation, and it's inherently cheap for small task sets
- Open-memory makes no attempt to cache SQLite query results either; freshness trumps efficiency

## References

- `@alkdev/taskgraph` `parseTaskDirectory`: async file reading + YAML frontmatter parsing
- Open-memory pattern: stateless queries, no caching between calls