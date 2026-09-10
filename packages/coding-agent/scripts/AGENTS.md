# packages/coding-agent/scripts

Developer tooling for the coding-agent package: vendoring upstream extension packages, app-server protocol codegen, reload benchmarking, legacy session migration. App-server QA lives in `qa-app-server/` (own AGENTS.md); shared JSONL RPC socket/host probes live separately in `qa-rpc-socket/`. Own file because this is a distinct tooling domain (score 9: file count, code ratio, symbol/export density) with a shared vendoring seam into `src/core/extensions/builtin/`.

## STRUCTURE

```text
sync-builtin-extensions.mjs      Vendor pi-extensions packages into src/core/extensions/builtin
vendor-transform.mjs             Shared import-rewrite transform used by vendoring
generate-app-server-protocol.sh  Regenerate src/modes/app-server/protocol/generated from codex
bench-reload.mjs                 DefaultResourceLoader.reload() benchmark vs synthetic extensions
migrate-sessions.sh              Legacy one-off: ~/.pi/agent/*.jsonl -> session dirs (v0.30.0 bug)
qa-app-server/                   App-server QA harness; see its AGENTS.md
qa-rpc-socket/                   Socket routing, ensure-host, host lifecycle, interactive/compiled host probes
```

## WHERE TO LOOK

| Task | First choice |
|---|---|
| Update a vendored builtin | `sync-builtin-extensions.mjs` + `vendor-transform.mjs` |
| Update app-server protocol types | `generate-app-server-protocol.sh` |
| Diagnose reload slowness | `bench-reload.mjs` (`--ext-count/--runs/--procs/--out`) |
| Run app-server transport QA | `qa-app-server/run-all.mjs` |
| Exercise shared JSONL RPC hosts | `qa-rpc-socket/{run,ensure-host,host-lifecycle,interactive-host,compiled-host}.mjs`; compiled probe needs `--binary <path>` |

## CONVENTIONS

- Vendoring source root defaults to sibling `../pi-extensions`; override with `SENPI_BUILTIN_EXTENSIONS_SOURCE`.
- `DIR_SYNCS` lists packages whose senpi adaptation is fully captured by the mechanical transform (auto re-copy); `MANUAL_PACKAGES` lists diverged copies — upstream version recorded in `external-versions.json` only, behavior ported by hand.
- `vendor-transform.mjs` owns the rewrite rules (drop published `.js` suffixes, `@mariozechner`/`@earendil-works` scope mapping, depth-relative core imports, Theme exception). Only transforms expressible there belong in `DIR_SYNCS`.
- `bench-reload.mjs` always uses an isolated temporary agent dir and probes via `node --import tsx` (same jiti path as `test/resource-loader.test.ts`); never touches real `~/.senpi`.
- Protocol codegen needs `codex` on PATH or `--from-checkout <dir>` pointing at a codex checkout; it writes `protocol/generated/` and `PROTOCOL_VERSION.txt`.

## ANTI-PATTERNS

- Re-copying a `MANUAL_PACKAGES` builtin — it clobbers hand-maintained divergence.
- Hand-editing `protocol/generated/` or mechanically copied `DIR_SYNCS` trees instead of using codegen or the sync transform; `MANUAL_PACKAGES` behavior is intentionally ported by hand.
- Running `bench-reload.mjs` against the real agent directory.

---

Parent: `packages/coding-agent/AGENTS.md`.
