# Upstream Automation

`.github/workflows/upstream-agent-merge.yml` checks `badlogic/pi-mono` hourly. When
`scripts/check-upstream-release.mjs` finds a release that is not merged into `main`, the
workflow runs Codex on an automation branch, opens a PR, waits for checks and QA evidence,
merge-commits the PR, then runs a fresh `/cl` audit before deciding whether to release.

## Required Repository Settings

- Actions must be allowed to create pull requests.
- The merge strategy must allow merge commits.
- A dedicated token is recommended because pushes made with `GITHUB_TOKEN` do not reliably
  trigger follow-up workflows.

## Secrets

- `UPSTREAM_AUTOMATION_TOKEN`: GitHub App installation token or PAT with contents write,
  pull requests write, checks/actions read, and issues write. It is used for branch push,
  PR merge, and release tag pushes.
- `CODEX_CONFIG_TOML_B64`: base64 of the local-style Codex `config.toml`.
- `CODEX_AUTH_JSON_B64`: base64 of the Codex `auth.json`. If the config uses only
  `QUOTIO_API_KEY`, this can be omitted.
- `CODEX_QUOTIO_CONFIG_TOML_B64`: optional base64 Codex `quotio.config.toml`.
- `CODEX_CCAPI_CONFIG_TOML_B64`: optional base64 Codex proxy config.
- `QUOTIO_API_KEY`: fallback key for a generated `quotio` provider config.
- `SENPI_AUTH_JSON_B64`: optional base64 of `~/.senpi/agent/auth.json` for gated manual QA.
- `SENPI_MODELS_JSON_B64`: optional base64 of `~/.senpi/agent/models.json`.
- `SENPI_MODELS_JSON_GZ_B64`: optional gzip+base64 of `~/.senpi/agent/models.json` when
  the plain base64 value exceeds the GitHub secret size limit.
- `SENPI_SETTINGS_JSON_B64`: optional base64 of `~/.senpi/agent/settings.json`.

Generate base64 values without printing decoded contents:

```bash
base64 < ~/.codex/config.toml | tr -d '\n' | gh secret set CODEX_CONFIG_TOML_B64
base64 < ~/.codex/auth.json | tr -d '\n' | gh secret set CODEX_AUTH_JSON_B64
base64 < ~/.senpi/agent/auth.json | tr -d '\n' | gh secret set SENPI_AUTH_JSON_B64
gzip -c ~/.senpi/agent/models.json | base64 | tr -d '\n' | gh secret set SENPI_MODELS_JSON_GZ_B64
```

## Runtime Tools

The workflow installs `@openai/codex@latest`, `lazycodex-ai@latest`, and
`oh-my-openagent@latest` at runtime. These stay out of `package.json` and lockfiles.

## Terminal States

Merge agent statuses:

- `MERGE_RESULT: CLEAN_PR_READY`
- `MERGE_RESULT: NO_RELEASE_NEEDED`
- `MERGE_RESULT: CONFLICTS`
- `MERGE_RESULT: QA_FAILED`
- `MERGE_RESULT: AGENT_FAILED`

Release audit statuses:

- `RELEASE_DECISION: RELEASE`
- `RELEASE_DECISION: SKIP`
- `RELEASE_DECISION: FAILED`

No-new-release and no-release-needed paths exit successfully. Conflict, QA, PR, and release
failures write a report and open one `sync-conflict` issue.

## Release Rule

The release step runs only after the upstream PR has been merge-committed into `main`, a fresh
`/cl` audit completes on that `main` tip, and `scripts/upstream-release-worthy.mjs` finds
package changelog entries under `## [Unreleased]`. `workflow_dispatch.force_release=true`
overrides the changelog-entry check.
