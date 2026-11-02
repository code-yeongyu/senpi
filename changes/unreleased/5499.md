<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-11-02 - An older remote catalog still adds the model ids the bundled catalog lacks (senpi#4314)

### What changed

- `packages/coding-agent/src/core/remote-catalog-provider.ts`: `remoteModels()` no longer drops a whole remote catalog entry when its `lastModified` is missing or not newer than the bundled catalog's `generatedAt`. Such an entry now contributes only the models whose type and id the bundled provider catalog does not have; models the bundled catalog has keep their bundled metadata, as before. A newer entry still overlays everything. A `404`/`501` catalog answer now persists an empty model list instead of keeping the previous cached models behind `lastModified: 0`, so a provider the catalog no longer serves cannot bring its old cached models back on the next start.

### Why

- The bundled catalog's generation time and the remote catalog's `Last-Modified` come from different sources. A remote catalog that is older by timestamp can still list a model the bundled catalog never had, and the all-or-nothing gate hid that model from both the cached overlay and a fresh fetch until the remote catalog changed again (senpi#4314, reported by GodCC6). The gate's purpose, keeping newer bundled metadata over older remote metadata, only applies to models both catalogs have.
- The old `404`/`501` branch relied on that gate to hide the cached models it kept; with the gate narrowed, it persists an empty list instead.

### Why an extension could not handle it

- The remote catalog overlay is wrapped around built-in providers inside `ModelRuntime.create()`; an extension cannot change which models the overlay contributes, and a manual `models.json` entry duplicates metadata the remote catalog already has.

### Expected merge conflict zones

- LOW: `remoteModels()` and the `404`/`501` branch of `refreshModels` in `remote-catalog-provider.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- A model that the remote model catalog lists but the bundled catalog lacks is now selectable even when the remote catalog is older than the bundled one; bundled metadata still wins for models both catalogs have. Thanks to @GodCC6 for the report ([#4314](https://github.com/code-yeongyu/senpi/issues/4314))
