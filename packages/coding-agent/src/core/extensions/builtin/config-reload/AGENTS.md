# builtin/config-reload

## OVERVIEW

Hash-gated config watching and idle reload handoff (score 8: nine TypeScript modules, entry boundary, dense symbols/exports); watches configuration, not extension runtime state.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Hook wiring, validation, reload handoff | `index.ts` | `configReloadExtension`, session-keyed `ConfigReloadHandoffRegistry` |
| Public in-process watch contract | `protocol.ts` | `config-watch:*` channels, payload guards, registration/filter rules |
| Hash snapshots / OS subscriptions | `watch-engine.ts` | `ConfigReloadWatchEngine`, directory-only targets and injectable clock/source |
| Worker-backed filesystem events | `watch-event-source.ts` | Platform-specific watcher ownership |
| Loaded extension entry scope | `extension-watch-scope.ts` | Mirrors loader discovery and `pi.extensions` manifest entries |
| Generated shim suppression | `generated-shim-filter.ts` | Avoid reacting to managed resource writes |
| Settings-only changes | `routine-settings.ts` | Settings content filtering |
| Veto deferral | `reload-deferral.ts` | Defer without losing pending changes |
| Redacted JSONL log | `log.ts` | Agent-directory `logs/config-reload.log` |

## CONVENTIONS

- `pi.events` is untyped; validate every external `config-watch:*` payload with `protocol.ts` guards. Later duplicate registration IDs replace earlier ones.
- Protocol targets are `file | dir`; the watch engine converts coverage into `dir | dir-recursive` directory watches so atomic file replacement remains visible.
- Recursive targets subscribe only to scanned in-scope directories, not a whole recursive OS subtree. Preserve the exclusions for dependency trees, `.git`, symlinks and filtered paths.
- Content hashes gate events; an OS notification alone is not a reload. Default debounce is 200 ms and tests can inject the clock, source and hash function.
- Extension watch scope follows one-level loader discovery except manifest-declared entries, which may be deeper. Goal persistence JSON is state, not reloadable source.
- Busy/compacting/vetoed sessions defer reload. Successful reload transfers a session-keyed handoff to the replacement factory so changes during reload are not lost.
- Shutdown retires watchers and continuations; a reload handoff survives only its intended replacement lifecycle.

## ANTI-PATTERNS

- Watching individual files directly; editor atomic renames invalidate that strategy.
- Treating filter strings as a full glob language: plain names, suffixes and leading-star suffixes only; a leading `/` anchors to the watch root.
- Reloading on every write anywhere under `extensions/`; runtime stores would trigger a feedback loop.
- Dropping pending changes when an extension vetoes reload or letting retired contexts request a new reload.

## VALIDATION

Existing targets: `test/config-reload-{protocol,watch-engine,extension-watch-scope,generated-shim}.test.ts` and `test/suite/config-reload-*.test.ts`.
Use injected watcher/clock events for deterministic cases; no fixed waits to guess whether a reload happened.
