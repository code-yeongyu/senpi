<!-- changes-log: scripts/changes.md -->
## 2026-11-13 - The forced release suite runs as matrix jobs on the tested commit (senpi#6642)

### What changed

- `scripts/release.mjs`: a new `--tested-sha <sha>` option (with `--sha` and `--shard-results <dir>`) releases the commit the forced-suite matrix jobs of `publish-npm.yml` tested. It skips the catalog regeneration and the in-job suite. Before stamping it refuses unless HEAD is that commit, `--sha` is on main's first-parent history, the tested commit is `--sha` itself or one commit whose only parent is `--sha` and whose diff touches only `REGENERATED_CATALOG_PATHS`, and every matrix job's result file reports a pass with tests on it. `--tested-sha` refuses `--force-tests`. Usage and argument parsing moved to `release-cli-args.mjs`, logging and git calls to `release-commands.mjs`, and the CI and tested-commit evidence to `release-ci-evidence.mjs`. Every other path behaves as before.
- `scripts/release-pin.mjs`: `assertReleasableCommit`, the read-only checks of `pinReleaseCommit`, is exported for the tested-commit path.
- `scripts/release-test-gate.mjs`: `catalogCommitMessage` names the release-only catalog commit in both paths.
- `scripts/release-forced-test-suite.mjs`: `FORCED_SHARD_JOBS` (6) is the matrix's coding-agent shard count, and `runForcedTestSuite` takes an `observe` line hook. The in-job `--force-tests` path keeps its 2 shards.
- `scripts/release-forced-prepare.mjs` (new): the prepare job. It pins `--sha`, regenerates and checks the catalog, commits a changed catalog on the release only, bundles that commit, and writes `base_sha`, `tested_sha`, `tested_tree`, `version` and `bundle`. When nothing changed, it outputs the dispatched commit and writes no bundle. The base commit is resolved once there and printed in full as a log line and the `base_sha` output. With `force_tests`, every later job and `release.mjs --sha` use that output, including when the dispatch named a sha.
- `scripts/release-forced-test-part.mjs` (new): one matrix job. It runs `rest` (scripts and every workspace but coding-agent) or coding-agent `--shard=i/6` on the tested commit only, and writes its result file.
- `scripts/release-forced-suite-results.mjs` (new): writes the per-part result files and checks all of them. `scripts/release-tested-lineage.mjs` (new): the lineage rule.

### Why

- A forced cut spent 74.6 of its 89.6 min running the suite in the one release job, with coding-agent in two shards on four vCPUs. Six shard jobs and one rest job each get their own runner, so the suite's wall time falls to about one shard. The release still tags only the tree those jobs tested.

### Why an extension could not handle it

- This is release tooling. Extensions do not run in the release workflow.

### Expected merge conflict zones

- MEDIUM: the imports and `main()` of `scripts/release.mjs`. Code that sat in the moved helpers now lives in `release-cli-args.mjs`, `release-commands.mjs` and `release-ci-evidence.mjs`.
