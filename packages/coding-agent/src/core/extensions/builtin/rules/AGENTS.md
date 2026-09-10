# builtin/rules

## OVERVIEW
Project-rule domain (score 8): static prompt rules and path-triggered dynamic rules share discovery but not injection state.

## WHERE TO LOOK

| Task | File |
|---|---|
| Host events and activation records | `index.ts` |
| Environment/flag defaults | `config.ts`, `rules/types.ts` |
| `/rules` and reload behavior | `commands.ts`, `ui/` |
| Static/dynamic lifecycle and fingerprints | `rules/engine.ts` |
| Locate rule sources | `rules/finder.ts`, `rules/project-root.ts` |
| Scan and parse `.md` / `.mdc` rules | `rules/scanner.ts`, `rules/parser.ts` |
| Match target paths and globs | `rules/matcher.ts` |
| Format injection blocks | `rules/formatter.ts` |
| Extract paths from tool results | `rules/tool-paths.ts` |

## CONVENTIONS

- Modes are `static`, `dynamic`, `both`, and `off`; CLI flags synchronize engine config on each relevant hook.
- The engine receives candidate discovery, file reads, project-root lookup, and tool-path extraction as dependencies.
- Static rules append to the base prompt every turn, even when a prior static-injection mark exists.
- Native context files are excluded using both supplied and canonical path keys.
- Dynamic fingerprints track all target paths, not just the first path displayed in the activation entry.
- Dynamic deduplication uses the `live-context` scope and remains separate from static marks.
- Accepted compaction resets session rule state; rejected compaction does not.
- Formatting limits default to 12,000 characters per rule and 40,000 per result.

## ANTI-PATTERNS

- Omitting a static block because an earlier turn already marked it injected.
- Injecting dynamic rules for errored tool results or rules already represented by native/static context.
- Invalidating the whole discovery cache for every unchanged target instead of checking fingerprints.
- Treating rule-activation display entries as the engine's authoritative injection state.
