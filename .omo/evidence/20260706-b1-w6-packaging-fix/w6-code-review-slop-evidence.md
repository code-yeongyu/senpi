# W6 Packaging Code Review / Slop Evidence

Scope: W6 packaging blockers from `.omo/evidence/20260706-b1-audit-w6-packaging-retry.md`.

Reviewed files:

- `scripts/prepare-senpi-bundled-workspaces.mjs`
- `scripts/prepare-senpi-bundled-workspaces.test.mjs`
- `scripts/prepare-senpi-bundled-workspaces.prepare.test.mjs`
- `Cargo.lock`
- `.omo/evidence/20260706-b1-w6-packaging-fix/todo32-pr-b2-split.md`

## Review checklist

- Security: no secret-bearing logs, credentials, auth headers, cookies, or environment dumps were added.
- Supply chain: `Cargo.lock` is committed instead of weakening the `--locked` native build contract.
- Packaging correctness: bundle assertions now require the loader-visible host native path, not just `native/index.js`.
- Non-host strategy: tests define the all-target ingestion contract, but PR-B1 does not add placeholder or fake `.node` files.
- Test quality: the new tests fail on absent host prebuilds and absent all-target artifact paths. They assert package file contracts rather than implementation-only helper calls.
- Slop categories: no deletion-only, tautological, implementation-mirroring, speculative parsing/normalization, broad catch, or fake compatibility shim was added.
- Oversized module dependency: the W6 audit flagged `packages/pty/src/session.ts` and `packages/pty/src/registry.ts`. Those runtime files are concurrently dirty from W2 split work and are outside this packaging commit. W6 records the dependency instead of marking that slop item complete here.

Recommendation: approve the W6 packaging delta only for host-prebuild packaging and the PR-B2 all-target assertion contract. Do not mark todo32/W6.3 complete until PR-B2 ingests real all-OS artifacts and records load/archive evidence.
