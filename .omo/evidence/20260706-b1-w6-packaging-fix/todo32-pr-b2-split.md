# PR-B1 W6.3 / todo32 Split Record

Status: split to PR-B2; not complete in PR-B1.

## PR-B1 packaging scope

- Commit and verify the Cargo lockfile required by the native `--locked` build path.
- Vendor and package the current host prebuild at the public loader path:
  `native/prebuilds/<platform>-<arch>/senpi_pty.<platform>-<arch>.node`.
- Keep the unified N-API prebuild layout for Node and Bun. No separate `native/node` or `native/bun` sidecar is claimed in PR-B1.
- Preserve the native-prebuild workflow matrix as the CI artifact producer for:
  `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, and `win32-x64`.
- Strengthen bundle/package assertions so the host prebuild is required now, and so the all-target artifact ingestion contract is testable without adding fake binaries.

## PR-B2 / todo32 remaining work

- Download or otherwise ingest successful `native-prebuild-*` workflow artifacts before final package/archive creation.
- Place each artifact at the loader-visible package path:
  `native/prebuilds/<platform>-<arch>/senpi_pty.<platform>-<arch>.node`.
- Make the release/archive validation call the all-target assertion over every supported target.
- Record Windows load evidence or explicitly revise the supported Windows target set.
- Rebuild local Node and Bun package installs from the archive that contains all ingested artifacts and probe `@earendil-works/pi-pty` through the public entrypoint.

## Non-claim

PR-B1 does not claim that all supported OS/arch `.node` files are already vendored locally. The package currently contains the host prebuild only unless CI artifacts have been ingested by a later release step.
