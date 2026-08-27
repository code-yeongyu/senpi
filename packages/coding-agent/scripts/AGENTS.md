# packages/coding-agent/scripts

Developer tooling for the coding-agent package: vendoring upstream extension packages, app-server protocol codegen, reload benchmarking, legacy session migration. The app-server QA harness lives in `qa-app-server/` (own AGENTS.md). Own file because this is a distinct tooling domain (score 13) with a shared vendoring seam into `src/core/extensions/builtin/`.

## STRUCTURE

```text
sync-builtin-extensions.mjs      Vendor pi-extensions packages into src/core/extensions/builtin
vendor-transform.mjs             Shared import-rewrite transform used by vendoring
generate-app-server-protocol.sh  Regenerate src/modes/app-server/protocol/generated from codex
bench-reload.mjs                 DefaultResourceLoader.reload() benchmark vs synthetic extensions
migrate-sessions.sh              Legacy one-off: ~/.pi/agent/*.jsonl -> session dirs (v0.30.0 bug)
qa-app-server/                   App-server QA harness; see its AGENTS.md
```

## WHERE TO LOOK

| Task | First choice |
|---|---|
| Update a vendored builtin | `sync-builtin-extensions.mjs` + `vendor-transform.mjs` |
| Update app-server protocol types | `generate-app-server-protocol.sh` |
| Diagnose reload slowness | `bench-reload.mjs` (`--ext-count/--runs/--procs/--out`) |
| Run transport QA | `qa-app-server/run-all.mjs` |

## CONVENTIONS

- Vendoring source root defaults to sibling `../pi-extensions`; override with `SENPI_BUILTIN_EXTENSIONS_SOURCE`.
- `DIR_SYNCS` lists packages whose senpi adaptation is fully captured by the mechanical transform (auto re-copy); `MANUAL_PACKAGES` lists diverged copies — upstream version recorded in `external-versions.json` only, behavior ported by hand.
- `vendor-transform.mjs` owns the rewrite rules (drop published `.js` suffixes, `@mariozechner`/`@earendil-works` scope mapping, depth-relative core imports, Theme exception). Only transforms expressible there belong in `DIR_SYNCS`.
- `bench-reload.mjs` always uses an isolated temporary agent dir and probes via `node --import tsx` (same jiti path as `test/resource-loader.test.ts`); never touches real `~/.senpi`.
- Protocol codegen needs `codex` on PATH or `--from-checkout <dir>` pointing at a codex checkout; it writes `protocol/generated/` and `PROTOCOL_VERSION.txt`.

## ANTI-PATTERNS

- Re-copying a `MANUAL_PACKAGES` builtin — it clobbers hand-maintained divergence.
- Hand-editing `protocol/generated/` or vendored builtin trees instead of going through the sync script + transform.
- Running `bench-reload.mjs` against the real agent directory.

---

Parent: `packages/coding-agent/AGENTS.md`.
