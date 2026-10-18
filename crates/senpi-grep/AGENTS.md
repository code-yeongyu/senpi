# crates/senpi-grep

`senpi-grep` is the Rust/N-API native grep implementation consumed by `packages/coding-agent` and bundled into Senpi binaries.

## STRUCTURE

```text
src/lib.rs              N-API exports and ABI marker
build.rs                N-API build setup
index.js, index.d.ts     Node package loader/types
```

## ABI CONTRACT

- `NATIVE_GREP_ABI_VERSION = "1"` in the TypeScript loader and the exported `__senpiGrepAbi1` marker must agree; the Rust constant lives in `src/lib.rs`.
- ABI versioning is intentionally separate from CalVer. Change it only for an incompatible native contract and update both crate and loader tests.
- `index.js` and `index.d.ts` are NAPI-RS-generated loader output; never hand-edit them. Regenerate with `npm exec --yes --package @napi-rs/cli@3.7.2 -- napi build --platform` from `crates/senpi-grep`.
- Keep the six targets declared in `package.json` aligned when changing exports or build paths. Grep prebuilds are never tracked in git (`crates/senpi-grep/*.node` and `packages/coding-agent/native/prebuilds/`); other hosts come from `native-prebuilds.yml`.

## VALIDATION

- Run `cargo test -p senpi-grep --locked` from the repository root.
- Rebuild the local addon with `npm exec --yes --package @napi-rs/cli@3.7.2 -- napi build --platform --release` from `crates/senpi-grep` after native changes.
