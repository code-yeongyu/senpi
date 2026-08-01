# Remediate PostCSS GHSA-r28c-9q8g-f849

## Objective

Eliminate the repository's only high-severity npm advisory with the smallest
deterministic dependency change and no unrelated lockfile drift.

## Diagnosis

- `npm audit --json` reports one HIGH advisory:
  GHSA-r28c-9q8g-f849, PostCSS path traversal through previous source-map
  auto-loading.
- Vulnerable range: `<=8.5.17`.
- Current lock resolution: `postcss@8.5.15`.
- Exact dependency path:
  `@code-yeongyu/senpi-evals -> vitest@4.1.10 -> vite@8.0.16 ->
  postcss@8.5.15`.
- First patched version: `8.5.18`.
- PostCSS is dev/build-time only, absent from the coding-agent install lock,
  and has no lifecycle scripts.

## Tier and topology

This PR is LIGHT and independent from the WebSocket recovery PR. A quick
implementation child may own the lockfile lane; the lead retains delivery,
review, CI, merge, and cleanup.

## Success criteria

### 1. Failing-first advisory proof

Before edits:

```text
npm audit --json -> high=1
npm ls postcss -> postcss@8.5.15
```

### 2. Surgical remediation

Add exact root override:

```json
"postcss": "8.5.18"
```

Refresh the lock with `PI_ALLOW_LOCKFILE_CHANGE=1` and
`npm install --package-lock-only --ignore-scripts`.

PASS: only `package.json`, `package-lock.json`, and this plan change; the lock
updates PostCSS version/resolution/integrity without unrelated dependency
movement.

### 3. Security and project validation

```text
npm audit --json -> high=0, total=0
npm ls postcss -> postcss@8.5.18
npm run check -> exit 0
npm run build -> exit 0
```

No lifecycle scripts may execute during the refresh.

## Delivery

Commit the plan first, open a draft PR, implement the exact override and lock
refresh, record RED/GREEN audit evidence, obtain review and CI, merge with a
merge commit, and remove
`/Users/yeongyu/local-workspaces/senpi-wt/postcss-ghsa-r28c`.

## Stop condition

Stop when the advisory PR is merged, npm audit reports no vulnerabilities, and
the task worktree is absent.
