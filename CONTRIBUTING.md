# Contributing to senpi

senpi is an opinionated fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). This guide covers the fork-specific contribution rules. For the upstream contribution culture, see pi-mono's [CONTRIBUTING.md](https://github.com/badlogic/pi-mono/blob/main/CONTRIBUTING.md).

## Philosophy

First things first: **pi's core is minimal**.

If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

Pi's core exists to be minimal and to be extensible so that it can be influenced and manipulated by extensions.  Even hook points for extensions however should be well considered and discussed to avoid adding unmaintainable bloat and complex interactions.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the senpi repo root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file and in the nearest subdirectory `AGENTS.md`.

## Fork Strategy (READ BEFORE EDITING `src/`)

senpi periodically merges selected upstream releases from `upstream` (i.e. `badlogic/pi-mono`). To keep merge commits reviewable:

1. **Extension-first** — every new feature lands as a builtin extension under `packages/coding-agent/src/core/extensions/builtin/`, or as a user extension under `packages/coding-agent/examples/extensions/`. Touch `core/` only when no extension hook can do the job.
2. **`changes.md` contract** — any modification to an upstream-tracked file MUST add a section to the nearest `changes.md` documenting *what changed, why, why an extension couldn't handle it, and expected merge-conflict zones*. See the existing files for templates.
3. **Skim the relevant `AGENTS.md`** in the directory you are about to modify. It tells you which patterns are load-bearing.

## Before Submitting a PR

```bash
# Bun is the fleet-standard invocation.
bun install --ignore-scripts
npm install --ignore-scripts # Contributor-compatible alternative
bun scripts/devenv-setup.mjs                 # default: npm prebuilds, no Rust toolchain required
bun scripts/devenv-setup.mjs --with-native   # optional: install pinned Rust toolchain and build native Rust workspace
bun run check     # Biome + tsc + browser-smoke check (pre-commit equivalent)
bun run test          # Vitest across workspaces (skips live-API)
./pi-test.sh      # Optional: live-API integration suite (env-gated; requires API keys)
```

The default dev setup intentionally avoids global Rust installation and uses checked-in/prebuilt native artifacts where available.
Use `--with-native` only when working on native Rust code; it reads `rust-toolchain.toml`, uses `rustup` to install the pinned
toolchain when `rustup` is available, and then runs the Rust native build/check path when a Cargo workspace exists. If Rust is
missing, the setup prints the exact rustup command to run instead of bootstrapping global tooling silently.

`bun run check` and `bun run test` must pass. The legacy npm equivalents remain supported for contributors. `./pi-test.sh` is only required when your change touches a provider that the live tests exercise.
If you touch MCP dependencies, keep `@modelcontextprotocol/sdk` exact-pinned and verify the workspace install with
`bun pm ls @modelcontextprotocol/sdk` (npm equivalent: `npm ls @modelcontextprotocol/sdk --workspace @code-yeongyu/senpi`).

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/ai`, see [`packages/ai/src/providers/AGENTS.md`](packages/ai/src/providers/AGENTS.md) for the 7-step checklist and required cross-provider tests.

## Releasing

senpi uses **CalVer** (Calendar Versioning), distinct from upstream `badlogic/pi-mono`'s semver line.

### Cutting a release

Locally:
```bash
bun run release             # uses today's UTC date
bun run release --dry-run   # preview without committing
```

The release script (`scripts/release.mjs`) imports `scripts/calver.mjs` to compute the next version, then:
1. Bumps every workspace listed in `scripts/release-packages.mjs` in lockstep.
2. Updates each package's `CHANGELOG.md`: `## [Unreleased]` → `## [<version>] - YYYY-MM-DD`.
3. Commits `release: v<version>`, tags it, and creates the fresh next-cycle
   `## [Unreleased]` commit.
4. Pushes `main` and the tag to `origin`.
5. The tag-triggered binary workflow builds and stages public artifacts.
6. The trusted `publish-npm.yml` workflow publishes all registry packages through GitHub OIDC with npm provenance.
7. After npm succeeds, the binary workflow makes the staged GitHub Release public.

Source workspace manifests are intentionally private. Real npm publication is
only supported through the trusted workflow; use `bun run publish:dry` for local
package validation.

### CalVer rules

- First release of the day: `YYYY.M.D` (e.g. `2026.5.13`).
- Same-day re-release: `YYYY.M.D-N` where N ≥ 2 (e.g. `2026.5.13-2`).
- All workspaces listed in `scripts/release-packages.mjs` always share the version.
- Tags are `v<version>` — `build-binaries.yml` triggers on these.

### Upstream sync

Merge upstream releases in a dedicated worktree from an up-to-date fork `main`. Merge the selected tag or commit
directly, preserve a real two-parent merge commit, and never squash or rebase away upstream ancestry.

Use `.github/upstream.json` as the machine-readable baseline, the committed `merge-upstream` skill and `/cl`
changelog-audit command under `.github/agent/`, and the per-file rules in
`.github/agent/merge-driver.md`. The `changes.md` files in fork-modified subdirectories describe what the fork
preserves and why.

Before updating the pull request, complete the dual-parent diff audit, changelog and lock integrity audit, focused
and canonical tests, and strict CLI/RPC/TUI manual QA. Merge only after those local gates are clean.

### CHANGELOG entries

> Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

This still applies. The release script will surface `[Unreleased]` entries; maintainers curate them before cutting a release.

## Quality Bar for Issues

If you open an issue:

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice. If you use an LLM to draft text, follow up with a clearly AI-labeled comment.
- State the bug or request clearly.
- Explain why it matters.
- Include a repro (minimal reproduction or exact command + observed vs expected).
- If you want to implement the change yourself, say so.

## Philosophy

senpi's core stays minimal. Most "this could be a feature" requests should be implemented as extensions ([`packages/coding-agent/src/core/extensions/builtin/`](packages/coding-agent/src/core/extensions/builtin/AGENTS.md) for in-tree, [`packages/coding-agent/examples/extensions/`](packages/coding-agent/examples/extensions/) for external).

If your change must modify upstream-tracked source:

1. Confirm no extension hook covers it (read [docs/extensions.md](packages/coding-agent/docs/extensions.md)).
2. Add a `changes.md` section before sending the PR.

PRs that bloat the core or skip `changes.md` will be asked to convert to an extension or document the modification.

## Style

- TAB indent (Biome `indentWidth: 3`). 120-column line width.
- Match the style of the surrounding file. The codebase is largely consistent — Biome plus the existing patterns are the source of truth.
- Use the path aliases defined in root `tsconfig.json` (`@earendil-works/pi-*`, `@code-yeongyu/senpi*`).

### Why are weekend issues lower priority?

We triage the tracker during working hours. That means more issues can accumulate over the weekend. Anything submitted Friday through Sunday may be missed or given lower priority in the Monday review queue. If a problem is urgent, ask on Discord and include the short version, a repro, and the relevant logs.

## Trademark and Brand References

Use third-party marks only to identify integrations, compatibility, providers, and required setup. Do not make senpi look endorsed by another project or vendor.

- Anthropic and Claude: use referentially for Anthropic APIs, Claude models, and Anthropic-specific extensions. Follow Anthropic's legal terms: <https://www.anthropic.com/legal>.
- OpenAI, ChatGPT, GPT, and GPT-4/GPT-5 model names: use referentially for OpenAI APIs and model compatibility. Follow OpenAI brand guidance: <https://openai.com/brand/>.
- GitHub and GitHub Actions: use referentially for repository and workflow behavior. Follow GitHub logo and trademark guidance: <https://github.com/logos>.
- Discord: use referentially for the upstream community link. Follow Discord branding guidance: <https://discord.com/branding>.

Prefer product-neutral wording in user-facing copy unless a specific provider or integration is technically required.

## Communication

- Issue and PR discussion happens on GitHub: <https://github.com/code-yeongyu/senpi>.
- Upstream pi-mono discussions: <https://discord.com/invite/3cU7Bz4UPx>.

## Is this gatekeeping?

No. It is a guardrail against burnout and tracker spam. Short, concrete, reproducible issues are welcome. Thoughtful contributions are welcome. Automated slop, entitlement, and large volumes of low-effort reports are not.

## Where can I learn about plans?

Earendil uses RFCs to discuss larger changes.  Not all of them are public, but
quite a few are.  They can be found at [rfc.earendil.com](https://rfc.earendil.com/keyword/pi/).
