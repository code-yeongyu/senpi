# senpi-desktop-engine fork changes

## 2026-09-27 - Document the engine crate layering (senpi#2128)

### What changed

- `packages/desktop-engine/README.md`: a "Crate layering" section with the dependency direction of the `crates/senpi-desktop-*` crates, matching their Cargo manifests.

### Why

- The final code-quality review (F2) found the Rust layering enforced only by the Cargo graph and documented nowhere.

### Why an extension could not handle it

- Package documentation.

### Expected merge conflict zones

- None.

