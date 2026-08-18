# changes — husky hooks

Tracker for git hook divergence from upstream `badlogic/pi-mono`.

## Repository-wide upstream divergence audit (2026-08-17)

### What changed

Canonical backfill seeded from the pre-backfill audit report under
`local-ignore/qa-evidence/20260817-changes-md-audit/pre-backfill-audit.json`
(upstream pin `badlogic/pi-mono` `v0.84.2`, `914cf1472e715297caa30db4b9535d534a9eb718`):

- `.husky/pre-commit`: fork added staged-file detection for package-manager-sensitive changes
  (root and workspace manifests, `.npmrc`, `pnpm-workspace.yaml`, bun/pnpm lockfiles, and the
  PM-sensitive build scripts) that runs `npm run verify:pms` — a full npm/bun/pnpm
  install+build in isolated temp dirs — with `SENPI_SKIP_PM_VERIFY=1` as a local-only escape
  hatch that CI still overrides. The fork also narrowed the browser-smoke trigger to
  `packages/ai/*`, `package.json`, and `package-lock.json` after removing the web-ui package.

### Why

- Senpi commits through three package managers (`build:npm`/`build:bun`/`build:pnpm` via
  `scripts/build-all.mjs` and `scripts/verify-package-managers.mjs`), while upstream only
  guarantees npm. Manifest-, rc-, lockfile-, or build-script-level breakage that installs fine
  under npm but fails under bun/pnpm must be caught at commit time, not in a later CI job or a
  broken release.

### Why an extension could not handle it

- The pre-commit hook is repository git policy executed by Husky before any Senpi runtime,
  session, or extension loader exists. Extensions run inside a coding-agent session and have no
  access to the commit lifecycle, staged-file inspection, or the shell environment in which the
  hook runs.

### Expected merge conflict zones

- MEDIUM: the hook body between the upstream lockfile guard (`scripts/check-lockfile-commit.mjs`)
  and the browser-smoke block; upstream edits to either neighbor will conflict with the fork's
  inserted multi-PM verification block.
- LOW: the browser-smoke case pattern, since upstream still lists the web-ui path Senpi removed.

## Multi package-manager pre-commit verification (2026-04-27)

### What changed

- Introduced the package-manager-sensitive staged-file classifier and `npm run verify:pms`
  gate in the sanepi fork-tree merge (`1ea83112b`), preferring `SENPI_SKIP_PM_VERIFY` over
  hard-failing developers who cannot run the full matrix locally, with CI enforcement kept
  unconditional.
- Narrowed the browser-smoke trigger on 2026-08-03 (`1d27f67b3`) when the web-ui package left
  the monorepo.

### Why

- The fork's release surface is installable through npm, bun, and pnpm; a hook-level verify is
  the cheapest place to catch PM-specific resolution or build failures before they reach a
  commit, while the escape hatch keeps local commits usable when the full matrix is
  impractical.

### Why an extension could not handle it

- Same as the canonical section: commit-time git policy with no session runtime available.

### Expected merge conflict zones

- The classifier case list whenever root or workspace manifest names change, and
  `scripts/verify-package-managers.mjs` itself, whose contract this hook calls.
