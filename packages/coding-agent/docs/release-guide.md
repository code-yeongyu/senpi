# Senpi 2026.7.30-2 Release and Installation Guide

This guide is the authoritative procedure for building, installing, and verifying Senpi
`2026.7.30-2` on:

- `mengmotaMac` — the local Apple Silicon development machine
- `mengmotaHost` / Jobdori — the remote Apple Silicon machine

The procedure deliberately does **not** publish to npm, create a Git tag, create a commit,
push a branch, or modify Senpi configuration. Both machines receive the same locally built
npm tarball, verified by SHA-256 before installation.

## Release summary

Senpi `2026.7.30-2` packages the post-`v2026.7.30` runtime work and updates the bundled MCP
SDK integration:

- recovers Kimi XML thinking channels and retries one empty assistant response
- reuses the active runtime API key for automatic session titles
- compacts proactively when an agent becomes idle above the configured threshold
- starts a freshly created durable goal immediately while preserving user grace for side questions on existing goals
- serializes multi-file apply-patch mutations and reports concrete failure reasons
- warns when high-reasoning and risky main-model selections are likely to waste capacity
- expands OMO workflow tips in interactive sessions
- updates `@modelcontextprotocol/sdk` from `1.29.0` to `1.30.0`
- updates `brace-expansion` from vulnerable `5.0.7` to patched `5.0.8`
- preserves every bundled extension registration and the separate hooks plugin loader

Read the package changelogs for the complete package-by-package breakdown.

## Non-negotiable config rule

Do not run release QA against the real Senpi agent directory.

The real directory is normally:

```text
~/.senpi/agent/
```

Every runtime command in this guide uses a disposable `HOME` and
`SENPI_CODING_AGENT_DIR`. Global npm installation changes the executable and package files
only; it does not need to read or write Senpi settings, credentials, sessions, extensions,
models, provider state, or authentication data.

Do not use these commands during this release procedure:

```bash
senpi install ...
senpi remove ...
senpi update
senpi --no-extensions
```

Package-management commands can change configured extension resources or use the normal
agent directory. They are unnecessary for verifying the bundled release.

## Prerequisites

Both machines must have:

- macOS on `arm64`
- Node.js `>=24`
- npm
- a working `senpi` global bin directory on `PATH`

The source machine additionally needs:

- the Senpi repository checkout
- Bun
- Git
- the repository dependencies
- `tmux` for the POSIX TUI smoke channel

Binary builds use the Bun 1.4+ canary channel. Local builders should run `bun upgrade --canary` first to ensure the toolchain matches CI.

Verify the local toolchain:

```bash
cd /Users/yeongyu/local-workspaces/senpi
uname -m
node --version
npm --version
bun upgrade --canary
bun --version
git status --short --branch
```

Verify Jobdori without entering its shared Senpi checkout:

```bash
ssh mengmotaHost 'uname -m; node --version; npm --version; command -v senpi'
```

Expected architecture on both machines is `arm64`.

## Release identity

This release uses CalVer:

```text
2026.7.30-2
```

The seven lockstep package manifests are:

- `packages/ai/package.json`
- `packages/agent/package.json`
- `packages/coding-agent/package.json`
- `packages/server/package.json`
- `packages/pty/package.json`
- `packages/senpi-codemode/package.json`
- `packages/tui/package.json`

`@earendil-works/pi-storage-sqlite-node` remains on its independent semver line and is not
part of the CalVer bump.

Confirm the source CLI identity without using real configuration:

```bash
QA_ROOT="$(mktemp -d)"
HOME="$QA_ROOT/home" \
SENPI_CODING_AGENT_DIR="$QA_ROOT/agent" \
PI_OFFLINE=1 \
node --import tsx packages/coding-agent/src/cli.ts --version
rm -rf "$QA_ROOT"
```

Expected output:

```text
2026.7.30-2
```

## Plugin and extension status

Senpi has several extension surfaces. They must not be conflated.

### Ordered builtins

The authoritative `builtinExtensions` registration order contains 31 extensions:

1. `hooks`
2. `permission-system`
3. `gpt-apply-patch`
4. `prompt-preset`
5. `todowrite`
6. `redraws`
7. `anthropic-web-search`
8. `anthropic-bash`
9. `openai-web-search`
10. `service-tier`
11. `model-fallback`
12. `recommended-models`
13. `bash-timeout`
14. `terminal`
15. `tool-pair-guard`
16. `compaction`
17. `history-search`
18. `help`
19. `import-repro`
20. `websearch`
21. `webfetch`
22. `video-in`
23. `look-at`
24. `nested-agents-md`
25. `rules`
26. `goal`
27. `ttsr`
28. `btw`
29. `claude-sdk-oauth`
30. `config-reload`
31. `mcp`

`mcp` remains last because its load order is intentional and load-bearing.

### Global defaults

Four global default extension factories load separately:

- `diff`
- `files`
- `prompt-url-widget`
- `tps`

### Other bundled surfaces

- `codemode` is bundled as `@code-yeongyu/senpi-codemode`.
- `llama.cpp` is a hidden inline extension.
- `.codex-plugin/plugin.json` belongs to the hooks plugin-manifest loader. Runtime-discovered
  hook plugins are user resources; no hook plugin is bundled by this repository.

### Version status

| Surface | Release status |
|---|---|
| `@modelcontextprotocol/sdk` | updated from exact `1.29.0` to exact `1.30.0` |
| `brace-expansion` | updated from vulnerable exact `5.0.7` to patched exact `5.0.8` |
| `@anthropic-ai/claude-agent-sdk` | current at exact `0.3.220` |
| `@code-yeongyu/senpi-codemode` | lockstep `2026.7.30-2` |
| eight vendored builtin snapshots | preserved from `external-versions.json` |

The vendored snapshot sources are mostly unpublished on npm. The configured sibling
`../pi-extensions` checkout and an accessible `code-yeongyu/pi-extensions` GitHub repository
were unavailable during this release. Their checked-in source plus
`external-versions.json` therefore remain authoritative; no version was guessed or fabricated.

### Known packaging warning

The isolated Bun package installation on the release machine reports
`incorrect peer dependency "@anthropic-ai/sdk@0.91.1"`. The source and packed manifests both
pin that exact SDK version, while the isolated npm installation, npm audit, standalone Bun
binary, and npm/Bun package CLIs all pass. Treat this as a Bun resolver warning; it does not
change the supported Node/npm installation path or require a configuration migration.

`release:local` stages the publish manifest and bundled package tree inside the source checkout
while packing. Run it from a clean, dedicated release checkout rather than a shared dirty
worktree. After packing, verify `packages/coding-agent/package.json` still has only the five
intentional internal bundle entries and run `npm install --ignore-scripts` before resuming
development so workspace dependency resolution is restored. Do not use destructive Git cleanup
when other work is present.

## Build and static verification

Run from the repository root:

```bash
npm run check
npm run build
CI=1 npm test
npm audit --omit=dev
```

The release-script checks are:

```bash
node scripts/generate-coding-agent-shrinkwrap.mjs --check
node scripts/generate-coding-agent-install-lock.mjs --check
node scripts/upstream-release-worthy.mjs
npm run release -- --dry-run
node scripts/release-notes.mjs extract \
  --version 2026.7.30-2 \
  --tag v2026.7.30-2
```

`npm run release -- --dry-run` is safe for this workflow. Do not run the live release command:
the live path commits, tags, and pushes.

## Plugin verification

Run the focused extension suites:

```bash
npm --prefix packages/coding-agent exec vitest -- \
  --run \
  test/suite/builtin-extension-sync.test.ts \
  test/suite/vendored-builtins.test.ts \
  test/extensions/loader-concurrency.test.ts \
  test/mcp/ \
  test/suite/claude-sdk-oauth-extension.test.ts \
  test/suite/terminal-extension.test.ts \
  test/compaction/ \
  test/ttsr/
```

The tests import the extension registry or use temporary fixtures. They do not discover
extensions from the real Senpi agent directory.

## Mandatory local QA

The repository QA harness creates isolated homes, sets offline mode, and guards real
authentication state.

Run:

```bash
node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check
node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --self-test
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --state
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test
node .agents/skills/senpi-qa/scripts/mock-loop.mjs \
  --with-tool \
  --api openai-responses
node .agents/skills/senpi-qa/scripts/tui-smoke.mjs \
  --self-test \
  --driver tmux \
  --evidence senpi-2026.7.30-2-tui
node .agents/skills/senpi-qa/scripts/pty-drive.mjs \
  --self-test \
  --evidence senpi-2026.7.30-2-pty
```

Evidence belongs under:

```text
local-ignore/qa-evidence/20260730-senpi-release-2026-7-30-2/
```

## Build the canonical release artifact

Choose one durable output directory outside the repository:

```bash
cd /Users/yeongyu/local-workspaces/senpi
ARTIFACT_ROOT="$HOME/.local/share/senpi-releases/2026.7.30-2"
npm run release:local -- --force --out "$ARTIFACT_ROOT"
```

The canonical npm tarball is:

```text
~/.local/share/senpi-releases/2026.7.30-2/tarballs/code-yeongyu-senpi-2026.7.30-2.tgz
```

Set variables and calculate its checksum:

```bash
ARTIFACT_ROOT="$HOME/.local/share/senpi-releases/2026.7.30-2"
TARBALL="$ARTIFACT_ROOT/tarballs/code-yeongyu-senpi-2026.7.30-2.tgz"
shasum -a 256 "$TARBALL"
```

Retain the checksum with the QA evidence. Jobdori must receive this exact file.

## Upgrade an existing installation

An upgrade uses the same checksum-verified tarball as a first installation. It replaces package
files only; Senpi settings, credentials, providers, models, permissions, sessions, and plugin
enablement files do not need a migration.

Record executable discovery before upgrading:

```bash
command -v senpi
senpi --version
npm prefix -g
```

Install the verified tarball through npm without lifecycle scripts, then refresh the shell’s
command cache:

```bash
npm install -g --ignore-scripts "$TARBALL"
hash -r
command -v senpi
senpi --version
```

The final version must be `2026.7.30-2`. If `command -v senpi` still points at another package
manager’s prefix, inspect that manager’s global package list and remove only its stale
`@code-yeongyu/senpi` package. Do not edit shell startup files or Senpi configuration merely to
change executable precedence. Re-run the isolated verification commands below after every
upgrade.

## Install on mengmotaMac

Install the verified tarball:

```bash
npm install -g --ignore-scripts "$TARBALL"
```

Create an isolated runtime home:

```bash
LOCAL_QA="$(mktemp -d)"
mkdir -p "$LOCAL_QA/home" "$LOCAL_QA/agent"
```

Exercise the installed CLI:

```bash
HOME="$LOCAL_QA/home" \
SENPI_CODING_AGENT_DIR="$LOCAL_QA/agent" \
PI_OFFLINE=1 \
senpi --version

HOME="$LOCAL_QA/home" \
SENPI_CODING_AGENT_DIR="$LOCAL_QA/agent" \
PI_OFFLINE=1 \
senpi --help

HOME="$LOCAL_QA/home" \
SENPI_CODING_AGENT_DIR="$LOCAL_QA/agent" \
PI_OFFLINE=1 \
senpi --list-models
```

The malformed-input scenario must fail:

```bash
HOME="$LOCAL_QA/home" \
SENPI_CODING_AGENT_DIR="$LOCAL_QA/agent" \
PI_OFFLINE=1 \
senpi --definitely-invalid
```

Expected results:

- `--version` prints exactly `2026.7.30-2`
- `--help` exits 0 and shows usage
- `--list-models` exits 0 offline and prints at least one model
- the invalid option exits nonzero and identifies the option as unknown

Remove the isolated runtime home after evidence is captured:

```bash
rm -rf "$LOCAL_QA"
```

## Transfer to Jobdori

Do not use or clean Jobdori’s shared Senpi source checkout.

Create a remote transfer directory and copy the tarball:

```bash
ssh mengmotaHost 'mkdir -p /tmp/senpi-2026.7.30-2'
scp "$TARBALL" \
  mengmotaHost:/tmp/senpi-2026.7.30-2/code-yeongyu-senpi-2026.7.30-2.tgz
```

Compare checksums:

```bash
shasum -a 256 "$TARBALL"
ssh mengmotaHost \
  'shasum -a 256 /tmp/senpi-2026.7.30-2/code-yeongyu-senpi-2026.7.30-2.tgz'
```

Do not install unless the two hashes are identical.

## Install on Jobdori

Install the transferred artifact:

```bash
ssh mengmotaHost \
  'npm install -g --ignore-scripts \
  /tmp/senpi-2026.7.30-2/code-yeongyu-senpi-2026.7.30-2.tgz'
```

Exercise the remote CLI inside an isolated home:

```bash
ssh mengmotaHost '
  REMOTE_QA=$(mktemp -d)
  mkdir -p "$REMOTE_QA/home" "$REMOTE_QA/agent"

  HOME="$REMOTE_QA/home" \
  SENPI_CODING_AGENT_DIR="$REMOTE_QA/agent" \
  PI_OFFLINE=1 \
  senpi --version

  HOME="$REMOTE_QA/home" \
  SENPI_CODING_AGENT_DIR="$REMOTE_QA/agent" \
  PI_OFFLINE=1 \
  senpi --help

  HOME="$REMOTE_QA/home" \
  SENPI_CODING_AGENT_DIR="$REMOTE_QA/agent" \
  PI_OFFLINE=1 \
  senpi --list-models

  if HOME="$REMOTE_QA/home" \
    SENPI_CODING_AGENT_DIR="$REMOTE_QA/agent" \
    PI_OFFLINE=1 \
    senpi --definitely-invalid
  then
    echo "invalid option unexpectedly succeeded" >&2
    rm -rf "$REMOTE_QA"
    exit 1
  fi

  rm -rf "$REMOTE_QA"
'
```

The expected observables are identical to the local installation.

## Configuration integrity proof

Before installation, calculate one composite digest for every regular file under the real
agent directory. Do not print individual file names, file contents, or per-file hashes.

Local:

```bash
CONFIG_DIR="$HOME/.senpi/agent"
find "$CONFIG_DIR" -type f -print0 |
  sort -z |
  xargs -0 shasum -a 256 |
  shasum -a 256
```

Jobdori:

```bash
ssh mengmotaHost '
  CONFIG_DIR="$HOME/.senpi/agent"
  find "$CONFIG_DIR" -type f -print0 |
    sort -z |
    xargs -0 shasum -a 256 |
    shasum -a 256
'
```

Repeat after all installation and QA steps. The before and after composite digests and file
counts must match exactly on each machine.

## Troubleshooting

### The source CLI reports the old version

Re-run version synchronization and lock generation:

```bash
node scripts/sync-versions.js
PI_ALLOW_LOCKFILE_CHANGE=1 npm install --package-lock-only --ignore-scripts
node scripts/generate-coding-agent-shrinkwrap.mjs
node scripts/generate-coding-agent-install-lock.mjs
```

Then rebuild before packaging.

### The installed CLI reports the old version

Confirm the tarball name and inspect npm’s global package:

```bash
npm list -g @code-yeongyu/senpi
command -v senpi
senpi --version
```

Reinstall the exact local tarball, not the registry’s `latest` tag.

### Jobdori’s checksum differs

Delete only the remote transfer file, copy it again, and re-run both hashes:

```bash
ssh mengmotaHost \
  'rm -f /tmp/senpi-2026.7.30-2/code-yeongyu-senpi-2026.7.30-2.tgz'
scp "$TARBALL" \
  mengmotaHost:/tmp/senpi-2026.7.30-2/code-yeongyu-senpi-2026.7.30-2.tgz
```

Do not install a mismatched artifact.

### A QA command tries to use real credentials

Stop immediately. Confirm the command sets:

```text
HOME=<temporary directory>
SENPI_CODING_AGENT_DIR=<temporary directory>/agent
PI_OFFLINE=1
```

The repository QA harness sets its own isolation variables. Do not override them with real
configuration paths.

### MCP tests fail after the SDK update

Run the MCP suite directly:

```bash
npm --prefix packages/coding-agent exec vitest -- --run test/mcp/
```

Make only compatibility changes required by a reproduced failure. Do not add fallback logic
for unsupported scenarios.

## Rollback and recovery

Rollback changes the executable package only. It does not remove or modify
`~/.senpi/agent/`.

Reinstall the prior published version:

```bash
npm install -g @code-yeongyu/senpi@2026.7.30
```

Verify rollback from an isolated home:

```bash
ROLLBACK_QA="$(mktemp -d)"
HOME="$ROLLBACK_QA/home" \
SENPI_CODING_AGENT_DIR="$ROLLBACK_QA/agent" \
PI_OFFLINE=1 \
senpi --version
rm -rf "$ROLLBACK_QA"
```

If only Jobdori must be rolled back, run the same install and isolated verification through
`ssh mengmotaHost`.

## Cleanup

After Jobdori is installed and verified:

```bash
ssh mengmotaHost 'rm -rf /tmp/senpi-2026.7.30-2'
```

Remove every temporary QA home. Keep:

- the installed `2026.7.30-2` package on both machines
- the canonical tarball
- its checksum
- the release notes
- the QA evidence directory

Do not remove the real Senpi agent directory.

## Maintenance checklist

For the next release:

1. Start from a clean, current `main`.
2. Audit every commit since the latest tag.
3. Update all affected package `[Unreleased]` sections.
4. Duplicate user-facing AI, agent, and TUI changes into the coding-agent changelog.
5. Query registry-verifiable plugin dependencies for newer exact versions.
6. Preserve vendored snapshots when no authoritative upstream source is available.
7. Update the seven lockstep package versions.
8. Regenerate package-lock, publish-deps lock, and install lock.
9. Run focused plugin tests.
10. Run `check`, `build`, and the full test suite.
11. Run the real Senpi QA channels.
12. Build one canonical local tarball.
13. Install that same checksum-identical tarball on every target machine.
14. Verify through isolated runtime homes.
15. Prove real Senpi configuration stayed unchanged.
16. Publish, tag, commit, or push only when separately authorized.
