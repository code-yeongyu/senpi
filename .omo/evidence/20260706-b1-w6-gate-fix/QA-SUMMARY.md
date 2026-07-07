# QA Summary

Manual QA channel: CLI stdout / parsed Node test transcript.

Verified scenarios:

- Old-test weakness demo: `node .omo/evidence/20260706-b1-w6-gate-fix/old-test-weakness.mjs`
  - Observable: old regex and constant-membership checks pass while behavior would still be broken.
  - Artifact: `01-old-test-weakness.log`.
- Local release pty package flow: `node --test scripts/local-release.test.mjs`
  - Observable: local-release child process exits 0; fake `npm` transcript shows `packages/pty` receives `npm run build` and `npm pack`; fake pty tarball exists.
  - Artifacts: `06-local-release-test-final.log`, `12-local-release-test-post-check.log`.
- Release version sync: `node --test scripts/release.test.mjs`
  - Observable: `applyWorkspaceVersions` mutates temp `packages/pty/package.json` from `0.0.0` to `2099.1.2`; test transcript passes 5/5.
  - Artifacts: `07-release-test-final.log`, `13-release-test-post-check.log`.
- Root check surface: `npm run check`
  - Observable: root check exits 0, including Biome, pinned deps, import checks, shrinkwrap/install-lock checks, `tsgo --noEmit`, browser smoke, web-ui check, and neo checks.
  - Artifact: `11-npm-run-check.log`.
- Native prebuild freshness: `npm run check:prebuild --workspace @earendil-works/pi-pty`
  - Observable: native prebuild reported fresh for `darwin-arm64`.
  - Artifact: `08-check-prebuild-pty.log`.
- Implementation-mirroring scan: `rg` over blocker tests.
  - Observable: no matches for old `readFileSync(...local-release.mjs)`, `WORKSPACE_PACKAGES.includes`, or `assert.match(scriptSource...)` patterns.
  - Artifact: `14-mirroring-scan.log`.
