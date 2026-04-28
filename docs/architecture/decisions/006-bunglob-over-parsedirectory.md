---
status: draft
last_updated: 2026-04-28
---

# ADR-006: Bun.Glob Over `parseTaskDirectory`

## Context

`@alkdev/taskgraph` provides `parseTaskDirectory(dirPath)` — a convenience function that recursively scans a directory for `.md` files and returns `TaskInput[]`. It uses `node:fs/promises.readdir` for directory traversal and silently skips files with invalid frontmatter.

The plugin needs more than what `parseTaskDirectory` provides:

1. **Raw file content** — the `show` operation returns full markdown body (frontmatter + description + acceptance criteria + notes). `parseTaskDirectory` only returns parsed frontmatter.
2. **Error detail by filename** — the `validate` operation reports which file failed and why. `parseTaskDirectory` silently skips invalid files with no error reporting.
3. **Bun-native runtime** — the plugin targets Bun. `Bun.Glob` and `Bun.file()` are native APIs with no Node compat overhead.
4. **Single-pass I/O** — read each file once. `parseTaskDirectory` + separate file reads for `show` would be two passes.

## Decision

Use `Bun.Glob("**/*.md")` for directory scanning, `Bun.file().text()` for reading, and `parseFrontmatter()` (singular, from `@alkdev/taskgraph`) for parsing. The `FileSource` class orchestrates this into a `SourceResult`.

We still use `parseFrontmatter()` for the YAML/schema validation — we just don't use `parseTaskDirectory` or `parseTaskFile` (which does the same thing but with `node:fs/promises.readFile`).

## Consequences

**Positive:**
- Single I/O pass per operation call — glob scan, read all files, parse in memory
- `rawFiles` Map gives full content for `show` without a second read
- `errors` array gives per-file error detail for `validate`
- Bun-native APIs (`Bun.Glob`, `Bun.file()`) — no Node compat layer
- Consistent with the TaskSource abstraction (see ADR-005)

**Negative:**
- Not using `parseTaskDirectory` means reimplementing directory scanning — but `Bun.Glob` is ~2 lines and more flexible
- Not using `parseTaskFile` means we call `parseFrontmatter()` directly after reading the file ourselves — same outcome, slightly more code
- The `rawFiles` Map keeps all file content in memory — acceptable for typical task sets (≤50 files, ≤100KB total)

## Benchmark

43 task files, all analysis functions, Bun runtime:
- `Bun.Glob` scan: ~1ms
- File read + `parseFrontmatter` (43 files): ~140ms
- `TaskGraph.fromTasks`: ~5ms
- All 6 analysis functions: ~17ms
- **Total**: ~150ms

The Rust CLI is faster on raw I/O/parsing (native binary), but the plugin eliminates subprocess overhead and plain-text parsing by the LLM. Overall tool call latency favors the plugin.

## References

- `@alkdev/taskgraph` `frontmatter/file-io.ts` — `parseTaskFile` and `parseTaskDirectory` implementations
- Bun API docs: `Bun.Glob`, `Bun.file()`