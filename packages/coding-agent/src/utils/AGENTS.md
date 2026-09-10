# packages/coding-agent/src/utils

Cross-cutting platform, parsing, image, and management-I/O helpers used by `core/`, `cli/`, `modes/`, and `extensions/`. 34 implementation files + one TypeScript declaration, all leaf-level. Score 12 — shared utility boundary with high import fan-in.

## FILES (grouped by concern)

```
utils/
├── git.ts                       # Parse package Git sources, refs, and safe host/repository paths
├── shell.ts                     # Shell selection/env, output sanitization, process-tree termination
├── child-process.ts             # cross-spawn wrappers + abort-aware child completion
├── paths.ts                     # Canonicalization, open-free symlink resolution, path normalization
├── fs-watch.ts                  # File watcher (used by reload + extension HMR)
├── open-browser.ts              # Open URL/file via platform handler; never goes through a shell
├── mime.ts                      # File extension → MIME type
├── clipboard.ts                 # Cross-platform clipboard read/write entry
├── clipboard-image.ts           # Clipboard image decode
├── clipboard-native.ts          # OS-specific clipboard backend
├── image-resize.ts              # Resize entry — runs image-resize-core in a worker, in-process fallback
├── image-resize-core.ts         # Photon resize implementation shared by main thread + worker
├── image-resize-worker.ts       # worker_threads entry wrapping image-resize-core
├── image-convert.ts             # Image format conversion
├── image-process.ts             # Shared conversion/resize pipeline
├── tool-result-images.ts        # Normalize tool-result image blocks
├── exif-orientation.ts          # EXIF rotation correction
├── photon.ts                    # @silvia-odwyer/photon-node WASM bootstrap
├── ansi.ts                      # ANSI escape regex + stripAnsi (vendored from ansi-regex/strip-ansi)
├── html.ts                      # HTML entity decoding
├── json.ts                      # stripJsonComments — strip // comments + trailing commas
├── syntax-highlight.ts          # highlight.js wrapper → themed terminal formatting
├── highlight-js.d.ts            # highlight.js language-module declarations
├── frontmatter.ts               # YAML frontmatter parser (skills, prompt templates)
├── sleep.ts                     # Promise-returning timer with abort
├── abort.ts                     # Operation signals + abort races
├── text.ts                      # Leading UTF-8 BOM normalization
├── duration.ts                  # Human-readable duration formatting
├── deprecation.ts               # One-shot deprecation warnings (deduped by message)
├── tools-manager.ts             # Probe + cache fd/rg presence for startup-tools
├── changelog.ts                 # Parse + render the senpi CHANGELOG.md
├── version-check.ts             # Senpi latest-version fetch (queries senpi npm, NOT pi.dev)
├── management-http.ts           # Bounded retries for idempotent management requests
├── pi-user-agent.ts             # UA string for update checks; uses runtime app name
├── windows-self-update.ts       # Quarantines locked native files so Windows self-update can replace them
└── changes.md                   # Fork tracker (version-check + pi-user-agent rebrand)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Select a shell / spawn a child | `shell.ts` for configuration; `child-process.ts` for spawn/wait |
| Resolve a path safely | `paths.ts` — strict variants for trust/containment; open-free variants avoid automounts |
| Detect fd/rg at startup | `tools-manager.ts` (cached, non-blocking; see `modes/interactive/startup-tools.ts`) |
| Parse a skill / prompt template | `frontmatter.ts` |
| Image-related work (paste, attachment) | `image-resize.ts`, `image-convert.ts`, `exif-orientation.ts` |
| Update-check or self-update | `version-check.ts` (senpi npm registry) — fork-modified |

## CONVENTIONS

- **Cross-platform first**: clipboard, paths, and shell paths all assume macOS/Linux/Windows. Test on at least two when changing.
- **No core/ or extensions/ imports**: utils sits at the bottom of the dependency graph. Reverse imports = circular.
- **Streaming-safe**: anything used during agent streaming (e.g. `tools-manager.ts`) must be non-blocking.
- **Senpi branding** in user-facing strings: version-check + UA use the runtime app name (resolved from `config.ts`), not hardcoded `"pi"`.

## ANTI-PATTERNS

- Importing from `core/` — utils is a leaf. Add data via parameter, not via `import`.
- Hard-coding `pi-mono` / `pi.dev` URLs — version-check queries the senpi npm package; pi-user-agent uses the runtime app name. See `changes.md` 2026-05-02.
- Adding new image dependencies — use `photon.ts` (WASM) over heavyweight native libs.
- Bypassing `tools-manager.ts` for fd/rg detection — duplicates the startup-tools probe.

## NOTES

- `photon.ts` is a WASM module; first call has a small init cost (cached). Don't move it into the streaming hot path.
- `tools-manager.ts` powers the fork's non-blocking startup probe (vs. upstream's awaited fd/rg download). See `modes/interactive/changes.md`.
- `frontmatter.ts` uses `yaml.parse`, strips a leading BOM, and is shared by skills and prompt templates.
- `management-http.ts` retries idempotent version/catalog/download requests, never model operations; caller abort and the overall timeout are terminal.
- `realpathWithoutOpen` tolerates resolution errors; `realpathWithoutOpenStrict` tolerates missing components only. Do not use an approximate path as proof of containment.
