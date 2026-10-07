# changes

## 2026-09-21 - Update the native build CLI (senpi#1895)

### What changed

- `crates/senpi-grep/package.json`: Updated the native build CLI to @napi-rs/cli 3.10.4.

### Why

- Keep the native addon build tooling on the reviewed 3.10.4 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `crates/senpi-grep/package.json`.
