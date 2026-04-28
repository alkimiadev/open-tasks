---
status: draft
last_updated: 2026-04-28
---

# ADR-005: TaskSource Abstraction

## Context

v1 of this plugin reads tasks from a local `tasks/` directory. But the purpose of the plugin is to give agents graph analysis and decomposition guidance — nowhere in that mission statement does "read files from a directory" appear. File I/O is an implementation detail.

Future sources are likely:
- **ApiSource** — tasks fetched from a project management tool (Jira, Linear, GitHub Issues) via HTTP
- **MixedSource** — merge local task files with remote tasks
- **TestSource** — in-memory tasks for unit testing operations without filesystem I/O

If every operation directly reads the filesystem, adding a new source means touching every operation.

## Decision

Define a `TaskSource` interface that operations use instead of direct filesystem access:

```typescript
interface TaskSource {
  readonly name: string
  load(): Promise<SourceResult>
}

interface SourceResult {
  tasks: TaskInput[]
  rawFiles: Map<string, string>
  errors: SourceError[]
}

interface SourceError {
  filePath: string
  error: string
}
```

The source is resolved once at plugin initialization (in `index.ts`) based on config, and passed to `createTools()` → registry → operations.

v1 implements only `FileSource` (reads from `tasks/` directory via `Bun.Glob` + `parseFrontmatter`). The factory function `createSource(config, workspaceDir)` returns the appropriate source.

## Consequences

**Positive:**
- Operations are decoupled from I/O — they call `source.load()` and get `SourceResult`
- Adding a new source means implementing `TaskSource` and updating the factory — zero operation changes
- `rawFiles` gives `show` operation full markdown content without a second I/O pass
- `errors` gives `validate` operation filenames with parse errors
- Testing is trivial — inject a `TestSource` with in-memory data, no filesystem mocking needed
- The "1 tool = 1 client" pattern (like an LLM client) emerges naturally: as sources expand, the plugin stays a single tool

**Negative:**
- One level of indirection for what's currently just file reading
- The `rawFiles` Map stores all file content in memory concurrently (acceptable for ≤50 files at a few KB each)

## References

- open-memory pattern: handlers directly query SQLite — no abstraction. That works because the data source is fixed (OpenCode's DB). Tasks data is more pluggable.
- @alkdev/taskgraph `parseTaskDirectory` returns only `TaskInput[]` — no raw content, no error detail. The TaskSource abstraction gives us both.