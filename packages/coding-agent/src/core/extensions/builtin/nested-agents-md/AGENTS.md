# builtin/nested-agents-md

## OVERVIEW
Directory-guidance injection domain (score 8): bounded, session-scoped discovery of nearby instruction files after file reads.

## WHERE TO LOOK

| Task | File |
|---|---|
| Host events and toggle command/flag | `index.ts` |
| Compose discovery, reads, budget, and cache | `core/inject-directory-context.ts` |
| Canonical containment | `core/containment.ts` |
| Walk ancestors for guidance | `core/find-agents-md-up.ts` |
| Session identity | `core/session-key.ts` |
| Deduplicate injected directories | `core/injection-cache.ts` |
| Filename and byte-limit defaults | `core/types.ts` |
| Format and truncate injected text | `core/format.ts`, `core/truncate.ts` |
| Typed file-read failures | `core/errors.ts` |
| Injection status/widget | `ui/reporter.ts` |

## CONVENTIONS

- Resolve containment before walking from the canonical file's parent to the canonical root.
- Cache keys pair session identity with the instruction file's directory, not just the requested filename.
- Defaults cap file content at 32 KiB and aggregate content per read at 128 KiB.
- Each file consumes the smaller of its per-file cap and the remaining read budget.
- Mark a directory injected only after a successful read and formatting pass.
- Read failures are returned in `InjectionResult.errors`; later candidates remain eligible.
- Metadata records original/injected byte counts and truncation separately from formatted text.

## ANTI-PATTERNS

- Using lexical path prefixes as a substitute for canonical containment.
- Sharing one injected-directory set across unrelated sessions.
- Charging character counts against a byte budget or splitting UTF-8 text unsafely.
- Caching failed reads as successful injections and thereby preventing later recovery.
