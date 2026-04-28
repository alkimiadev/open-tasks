---
status: stable
last_updated: 2026-04-28
---

# ADR-004: Frontmatter Field Name Normalization (depends_on / dependsOn)

## Context

There was a naming divergence between the Rust CLI and the TypeScript core library for the dependency field:

| Source | Field name in YAML | Field name in struct |
|--------|--------------------|---------------------|
| Rust CLI (`taskgraph`) | `depends_on` | `depends_on` |
| TypeScript lib (`@alkdev/taskgraph`) | `dependsOn` | `dependsOn` |

The `yaml` npm package does **not** auto-convert snake_case to camelCase. A markdown file with `depends_on: [a, b]` would parse to `{depends_on: ["a", "b"]}`, which the `TaskInput` schema (expecting `dependsOn`) rejected as an unknown property. `Value.Clean()` would strip it, and `Value.Check()` would fail because the required field was missing.

This was a bug in `@alkdev/taskgraph`. The library's `parseFrontmatter()` function contract says it accepts "markdown with YAML frontmatter" — but the YAML convention established by the Rust CLI ecosystem was `depends_on`, and the parser silently discarded it.

**Broader point**: This was a textbook example of how issues upstream increase the surface area of issues downstream. A field naming convention in the Rust implementation created a compatibility fault line that propagated to every consumer. These are the "corners" that are hard to see around in linear text — exactly the kind of problem DAG-structured task analysis is designed to surface.

## Decision

**Fixed upstream in `@alkdev/taskgraph` v0.0.2**: A normalization step was added to `parseFrontmatter()` between YAML parsing and `Value.Clean()`. Known snake_case aliases are mapped to their camelCase canonical names.

The normalization map:

```typescript
const KEY_ALIASES: Record<string, string> = {
  depends_on: "dependsOn",
}
```

Applied after YAML parse, before `Value.Clean()`. Both `depends_on` and `dependsOn` are now accepted in YAML frontmatter. The canonical form for new files is `dependsOn` (camelCase).

## Resolution

- `@alkdev/taskgraph` v0.0.2 includes the fix
- This plugin pins `^0.0.2` in its dependencies
- No plugin-level workaround needed
- The `depends_on` / `dependsOn` compatibility surface is resolved

## Impact on This Plugin

**Resolved**. Task files using either `depends_on` (Rust CLI convention) or `dependsOn` (TypeScript canonical) parse correctly. No preprocessing, workarounds, or special handling required in the plugin.

AGENTS.md documents `dependsOn` as the canonical form for new task files, with a note that both forms are accepted.

## References

- Rust CLI `struct TaskFrontmatter`: uses `depends_on` (snake_case, Serde default)
- TypeScript `TaskInput` schema: uses `dependsOn` (camelCase, JS convention)
- `yaml` npm package: preserves YAML key casing as-is (no auto-conversion)
- `Value.Clean()`: previously stripped `depends_on` as unknown property — now handled by normalization upstream