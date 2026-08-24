# Local fork changes

## Release dependency refresh and lock regeneration (2026-08-24)

### What changed

- `packages/coding-agent/package.json`: `@anthropic-ai/claude-agent-sdk` 0.3.238 -> 0.3.241, `@aws-sdk/client-bedrock-runtime` 3.1115.0 -> 3.1116.0, and `typebox` 1.3.16 -> 1.3.18.
- The coding-agent publish dependency closure, install lock, and Claude Agent SDK platform lock were regenerated from the refreshed exact pins.

### Why

- These are the compatible dependency updates selected for the 2026.8.24 release. The generated locks are part of the published package contract and must match the manifest exactly.
- The Discord-reported Bun 1.4 redirect cleanup failure is already fixed in the same release line by feature-detecting `body.dump()` and falling back to argument-free stream destruction.

### Why an extension could not handle it

- Package resolution and the redirect response-body cleanup helper both execute below the extension interception surface.

### Expected merge conflict zones

- HIGH: `package.json` and the generated publish/install/platform locks.
- LOW: the redirect response-body compatibility helper and its regression test.

## models.json schema accepts the video input modality (2026-08-23)

### What changed

- `packages/coding-agent/src/core/model-config-schema.ts`: the `input` unions of `ModelDefinitionSchema` and `ModelOverrideSchema` now accept `video` in addition to `text` and `image`.
- `packages/coding-agent/test/suite/regressions/0002-models-json-video-input.test.ts`: failing-first regression covering `models[]` acceptance, `modelOverrides` acceptance, and continued `audio` rejection (`audio` exists nowhere in the runtime type).
- `packages/coding-agent/CHANGELOG.md`: [Unreleased] entry referencing PR #1087.

### Why

- The fork types `Model.input` as `("text" | "image" | "video")[]` (`packages/ai/src/model.ts`) and ships builtin `kimi-coding` k3 declaring `["text","image","video"]`, but the user-facing models.json schema was never extended when video support landed. Any user provider declaring video failed validation, and `ModelConfig.loadSync` rejects the entire file on any schema error — unregistering every user-defined provider and surfacing only a misleading fallback-chain "roles are unsupported" warning downstream. Upstream pi-mono is consistently `text|image` in both the type and the schema, so this gap is fork-introduced; this change closes it on the schema side only. The all-or-nothing rejection semantics and the fallback-warning wording are deliberately untouched (separate design concerns).

### Why an extension could not handle it

- The schema is the load-time gate for every user provider; extensions run after `ModelConfig` has already accepted or rejected the file.

### Expected merge conflict zones

- LOW: two single-line unions in `model-config-schema.ts`; upstream has not touched this schema since the fork split it from `model-config.ts`.

## Coding-agent dependency refresh and generated install-lock update (2026-08-20)

### What changed

- `packages/coding-agent/package.json`: `@anthropic-ai/claude-agent-sdk` 0.3.220 -> 0.3.238, `@aws-sdk/client-bedrock-runtime` 3.1112.0 -> 3.1115.0, `@smithy/node-http-handler` 4.11.2 -> 4.11.3, `grok-mermaid` 0.2.2 -> 0.2.3, `highlight.js` 11.11.1 -> 11.12.0, `marked` 18.0.7 -> 18.0.10, `minimatch` 10.2.5 -> 10.2.6, `undici` 8.9.0 -> 8.10.0, `ws` 8.21.1 -> 8.21.3, `typebox` 1.3.8 -> 1.3.16, and `jsdom` 29.1.1 -> 30.0.1 with `@types/jsdom` 28.0.3 -> 30.0.0; the overrides block follows the root on `@hono/node-server` 2.1.1 and `rimraf` 6.1.3. Removed the unused `@mistralai/mistralai` dependency and the unused `@types/ms` devDependency. `@anthropic-ai/sdk` stays at 0.91.1, and `openai` stays at 6.26.0 and `signal-exit` at 3.0.7 as deliberate pins.
- `packages/coding-agent/install-lock/package.json` and `packages/coding-agent/install-lock/package-lock.json`: regenerated from the refreshed root lock.
- `packages/coding-agent/publish-deps.lock.json`: regenerated shrinkwrap for the same tree.
- `packages/coding-agent/test/mermaid.test.ts`: the two tests covering the partial-render warning path now use input that still warns under grok-mermaid 0.2.3, which learned to render the `:::className` node syntax the old fixtures relied on failing.
- `packages/coding-agent/test/suite/claude-sdk-oauth-naming.test.ts`: asserts the upstream package name without pinning its version, since the naming boundary is the subject of the test.

### Why

- jsdom 30 ships no bundled types, so `@types/jsdom` stays and moves in lockstep; the bun-compile asset patch in `scripts/prepare-bun-compile-assets.mjs` still matches both jsdom internals it rewrites, and the `build:binary` `xhr-sync-worker.js` entry still resolves. `@mistralai/mistralai` and `@types/ms` had zero source references here, and the remaining import-less dependencies stay declared because pi-ai and pi-tui are bundled into this package and their runtime dependencies must resolve from it. The two test edits track real upstream behavior changes rather than relaxing an assertion: both still exercise the same production branches.

### Why an extension could not handle it

- The dependency set, the generated install-lock, and the published shrinkwrap are resolved by npm and by repository tooling before the extension runtime loads, and the bundled-dependency contract is a packaging property of this package.

### Expected merge conflict zones

- HIGH: the `dependencies` block in `packages/coding-agent/package.json` and the two generated lock artifacts, which upstream regenerates on every release.
- LOW: the two test fixtures, which only move when the corresponding upstream package changes behavior.

## Repository-wide changes.md audit backfill for package manifests and configs (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin 914cf147, tag v0.84.2): records the package-root manifest and config deltas. Runtime deltas under `src/` are tracked by their nearest nested changes.md files, and the TypeScript toolchain migration rationale is in the 2026-08-02 entry.
- `packages/coding-agent/package.json`: fork identity - renamed to `@code-yeongyu/senpi` with `private: true`, CalVer versioning, `piConfig` name `senpi` with config dir `.senpi`, the `senpi` bin, the fork repository URL, and Node `>=24`. Build scripts run `tsc` (TypeScript 7.0.2) and emit `dist/senpi`; `build:binary` builds the `../pty` workspace first, runs `prepare-bun-compile-assets.mjs`, and compiles with Bun `--compile-autoload-package-json --minify --keep-names` plus the embedded jsdom worker. Asset staging copies css-tree, mdn-data, and source-map-js into `dist/node_modules`, stages the codemode sidecar, TUI native prebuilds, PTY natives, and the imagegen skill, and adds the `qa:app-server` runner. Dependencies are the exact-pinned fork runtime set (Claude/Anthropic/Bedrock/Mistral/OpenAI SDKs, MCP, jsdom, marked, turndown, readability, proxy agents, OpenTelemetry, zod, and more) plus the five-workspace `bundledDependencies` list, the `@hono/node-server` override, and `npm-shrinkwrap.json` removed from `files`.
- `packages/coding-agent/install-lock/package.json`: renamed to `@code-yeongyu/senpi-install`, versioned in CalVer, depends on the matching `@code-yeongyu/senpi` version, adds the `@hono/node-server` override, and requires Node `>=24`.
- `packages/coding-agent/tsconfig.build.json`: added `@earendil-works/pi-pty` and `pi-pty/*` path mappings to the PTY workspace's `dist` declarations, and excluded `src/modes/app-server/protocol/generated/**` so the vendored Codex protocol types stay out of the build program and dist output.
- `packages/coding-agent/tsconfig.examples.json`: examples resolve the SDK through the fork identity - the `@earendil-works/pi-coding-agent` and `/hooks` aliases were replaced by `@code-yeongyu/senpi` pointing at `./src/index.ts`.
- `packages/coding-agent/vitest.config.ts`: a global `./test/setup.ts` setup file quarantines `SENPI_CODING_AGENT_DIR` (and clears `PI_RULES_*` variables) so suites never write faux-provider session JSONLs into the developer's real agent directory; when `CI` or `GITHUB_ACTIONS` is set, the forks pool is capped at two workers with a 20-second teardown so subprocess-heavy MCP, PTY, and app-server suites do not oversubscribe 4-vCPU runners or hang pool shutdown (measured 1364s single-fork, dominated by per-file import cost); resolve aliases map `@earendil-works/pi-ai/node/provider-scope` and `@earendil-works/pi-pty` to the sibling workspace sources.

### Why

- These are the package-root halves of fork changes whose runtime halves are recorded under `src/`. Without this record, a naive upstream merge would restore the upstream package identity, `tsgo` scripts, caret-pinned upstream workspace ranges, an untyped CI vitest pool, and example aliases that no longer resolve.
- The vitest setup and pool cap encode two measured failures: leaked session writes permanently polluting real transcript directories, and unreaped subprocess children hanging the whole test step on constrained runners.

### Why an extension could not handle it

- Package manifests, TypeScript project configurations, and the Vitest harness are build and test infrastructure loaded before the coding-agent runtime or any extension exists.

### Expected merge conflict zones

- HIGH: `packages/coding-agent/package.json` scripts, dependencies, and bundling whenever upstream re-versions or reshapes packaging.
- MEDIUM: `packages/coding-agent/vitest.config.ts` pool, setup, and alias sections, and `packages/coding-agent/tsconfig.build.json` path and exclude lists.
- LOW: `packages/coding-agent/tsconfig.examples.json` alias map and `packages/coding-agent/install-lock/package.json` identity and engines lines.

## 2026-08-17 — Dollar invocation and RPC contract regression suites ([PR #909](https://github.com/code-yeongyu/senpi/pull/909))

### What changed

- Added focused RPC suites for ordered `commands_changed` snapshots, actual post-interception
  `command_invocation` events, bounded prompt/steer/follow-up text, and `skill_invocation`
  delivery without MCP inventory drift.
- Added classic and multi-session malformed-command regressions plus JSONL record-cap,
  discard-through-LF resynchronization, and worst-case escaped-message coverage.
- Expanded the #308 skill-composition suite to cover dollar/slash ordering, unknown and
  duplicate tokens, ordinary dollar text, indentation preservation, token-discovery bounds,
  the five-skill expansion cap, and queued steering/follow-up behavior.
- Added TUI autocomplete/editor regressions for mixed dollar candidates and real trigger input.

### Why this lives in the fork

Senpi owns the dollar composer syntax, typed JSONL event contract, and OmO Desktop compatibility
surface. Upstream does not expose these exact candidate or invocation events, so a naive merge
would otherwise drop the only regression coverage for the fork contract.

### Expected merge-conflict zones

- `test/rpc-command-invocation.test.ts`, `test/rpc-commands-changed.test.ts`,
  `test/rpc-input-validation.test.ts`, `test/rpc-jsonl.test.ts`, `test/rpc-multi-session-input.test.ts`,
  `test/rpc-loaded-surfaces.test.ts`, and `test/suite/regressions/5868-rpc-unknown-command-id.test.ts`
  resolve to `ours`; port upstream additions into the retained suites.
- `test/suite/regressions/308-skill-composition.test.ts` resolves case by case while preserving
  every dollar/slash, indentation, cap, and queueing assertion.
- TUI dollar autocomplete tests resolve to `ours` unless upstream adds equivalent `$` behavior.

## 2026-08-16 — Dual JSONC/JSON settings coverage

### What changed

- Added deterministic settings-manager coverage for JSONC comments/trailing commas, JSONC-over-JSON precedence, JSON-only compatibility, write-target preservation, and reload reselection.
- Added real connection-handler coverage for the `settings_source_selected` RPC record, focused interactive notice coverage, and config-reload coverage for valid JSONC edits.

### Why this lives in the fork

- The fork owns the source-selection event and interactive/config-reload integration around the upstream-derived settings manager.

### Why an extension could not do this

- The tests pin pre-extension settings parsing, persistence, host event delivery, and built-in reload behavior.

### Expected merge-conflict zones

- `test/settings-manager.test.ts`, `test/suite/harness.ts`, and `test/suite/config-reload-extension.test.ts`; the two focused source-event tests are additive files.

## 2026-08-14 — RPC stream regression suites for multi-session compaction

### What changed

- `test/rpc-multi-session-events.test.ts` gained the coverage for the multi-session
  event writer's per-session compaction and single-flight drain: a 1000-update
  stalled-writer load case that asserts no assistant transition is lost and the
  retained bytes stay far below the sum of the cumulative records, latest-wins
  coalescing keyed by `toolCallId` in occurrence order, barrier isolation, and
  the seal/late-enqueue contract.
- `test/rpc-event-coalescing.test.ts` gained two characterization pins for the
  CLASSIC single-session path: every delta survives same-tick batching into one
  raw write, and immediate barriers keep event/UI-request/response ordering.
  Both were proven to bite under their own targeted mutation.
- The behavior these suites cover is described in `src/modes/rpc/changes.md`
  (2026-08-14 entry); this entry exists so the package-level log records the
  test surface that guards it.

### Why this lives in the fork

The compaction and single-flight drain are fork-specific: upstream writes every
record straight through, so these suites have no upstream counterpart and would
be dropped by a naive merge resolution.

### Expected merge-conflict zones

`test/rpc-multi-session-events.test.ts` and `test/rpc-event-coalescing.test.ts`
resolve to `ours`. If upstream adds cases to either file, port them INTO these
suites rather than replacing them - deleting the compaction or classic-pin cases
silently removes the only guard against reintroducing the O(n^2) wire
amplification or dropping classic per-event backpressure.

## 2026-08-12 — Distinguish external-editor launch failures

### What changed

- Prompt editing now reports `launch-failed` when the configured external
  editor process never starts, instead of returning the same `failed` status
  used when an editor actually launches and exits nonzero or by signal.
- Added a deterministic regression that invokes the real prompt-editor code
  with a guaranteed-missing executable and proves the operating system's
  process-launch failure remains distinct from an editor exit.
- Added a bounded stress harness that runs the prompt/file external-editor
  suites 25 times sequentially and four times concurrently, while asserting
  every child exit and exact before/after temporary-directory residue.

### Why this lives in the fork

- Senpi's interactive composer owns the external-editor handoff and its
  temporary prompt file. The return status determines whether callers may
  assume the editor ran and could have produced side effects.
- Full-suite subprocess pressure can make `spawn()` fail before launch. Folding
  that condition into a normal editor failure made tests and callers reason
  from side effects that never happened.

### Why this cannot be expressed externally

- Extensions receive control after the built-in composer and process lifecycle
  contract have already been selected. They cannot distinguish a swallowed
  host `spawn` error from a real editor exit.

### Expected merge conflict zones

- `src/modes/interactive/external-editor.ts` around prompt-editor child-process
  outcome handling.
- `test/external-editor.test.ts` around real-child lifecycle coverage.

## 2026-08-11 — Ship codemode with standalone binaries

### What changed

- Added one manifest-driven copier for the source-only codemode runtime payload.
- Both `npm run build:binary` and the six-platform release archive build now
  stage codemode under the executable's adjacent
  `node_modules/@code-yeongyu/senpi-codemode` path.
- A clean package-level `build:binary` now builds the PTY workspace before
  coding-agent so its declarations are present without relying on stale root
  build output.
- Package-level binary compilation now embeds `css-tree`, matching the
  six-platform release build instead of externalizing a dependency that Bun's
  `$bunfs` resolver cannot load from an adjacent `node_modules`.
- The copier replaces stale output and excludes package tests, development
  dependencies, and repository-only files.

### Why this lives in the fork

- Codemode is a fork-owned default-on extension distributed with Senpi.
  npm's `bundleDependencies` controls npm tarballs but does not embed or copy
  dynamically resolved source packages into Bun standalone archives.

### Why this cannot be expressed externally

- The archive layout and Bun sidecars are constructed before user extensions
  load, so an extension cannot add its own missing package to the executable
  distribution.

### Expected merge conflict zones

- `packages/coding-agent/package.json` around `copy-binary-assets`.
- `scripts/build-binaries.sh` around shared platform sidecars.
- `scripts/copy-codemode-sidecar.mjs` and its contract test.

## 2026-08-09 — General extension filesystem policy API

### What changed

- Documented `pi.registerFilesystemPolicy()` as a factory-time API for canonical read, enumerate, and write decisions.
- Added deterministic coverage for registration, deny-wins composition, real/missing/symlink path canonicalization, all
  six built-in file tools, denied-root metadata, approval-hook non-bypassability, and a general extension that limits
  writes to its own workspace root.

### Why this lives in the fork

- The public extension contract and built-in executor tests are package-level surfaces. A consumer extension can use the
  policy after it exists but cannot add or verify the host hook itself.

### Expected merge conflict zones

- LOW: `docs/extensions.md`, `test/filesystem-policy.test.ts`, and package type-export lists.

## 2026-08-03 — Keep Bun off unpublished workspace identities

### What changed

- Moved the built client and protocol payloads from the package-manager-owned `node_modules` bundle into flat `vendor/pi-client` and `vendor/pi-protocol` trees.
- Rewrote coding-agent declaration/runtime imports and the vendored client package's protocol imports to relative paths inside that vendor tree.
- Removed client/protocol registry edges from the published Senpi manifest while preserving their runtime and declaration surface in the tarball.
- Pinned fork-owned registry aliases and the codemode Senpi peer to the exact CalVer revision instead of caret ranges that can select an older stable release over a `-N` revision.
- Made the staging contract explicit: local publish validation rewrites emitted `dist` imports and must rebuild coding-agent after restoring the checked manifest.
- Removed the uncreatable `@code-yeongyu/senpi-client` and `@code-yeongyu/senpi-protocol` entries from the publish matrix.
- Added release-script coverage for exact resolver targets, the publish matrix, vendored package identities, peer pinning, and rewritten declarations.

### Why this lives in the fork

- Bun resolves npm registry metadata before consuming bundled dependencies, so unpublished workspace identities cannot remain in the effective package-manager graph even when their files are embedded in the tarball.
- CalVer revisions such as `2026.8.3-2` are SemVer prereleases; a caret range can legally resolve to the older stable `2026.8.3`, reintroducing that release's broken dependency graph.
- npm trusted publishing is configured per existing package and cannot bootstrap a new package name, so adding standalone client/protocol aliases made the release workflow fail before the Senpi package could publish.

### Why this cannot be expressed externally

- The resolver aliases, exact version pins, vendored declaration paths, bundle manifest, and package publication order are generated inside the repository release scripts; an extension cannot change npm metadata or the contents of the published tarball.

### Expected merge conflict zones

- `scripts/prepare-senpi-publish-manifest.mjs` registry alias and exact-version mapping.
- `scripts/prepare-senpi-bundled-workspaces.mjs` bundled/vendored workspace staging and declaration rewriting.
- `scripts/publish-manifest.mjs` codemode peer pinning.
- `scripts/publish.mjs` package publication list.
- `scripts/prepare-senpi-bundled-workspaces.prepare.test.mjs`, `scripts/prepare-senpi-publish-optionals.test.mjs`, `scripts/publish-manifest.test.mjs`, and `scripts/publish-registry-dependencies.test.mjs` release coverage.

## 2026-08-03 — Make the editor prompt marker visually explicit

### What changed

- Reserved a two-column prompt gutter in the coding-agent `CustomEditor`.
- Rendered an accent-styled `❯` on the first editable row and aligned wrapped rows beneath the text column.
- Preserved that gutter when session/settings reloads reapply an `editorPaddingX` value below two.
- Kept `getPaddingX()` reporting the configured value so existing editor construction and extension handoff contracts remain stable.
- Hid the marker when the editor is vertically scrolled so it never appears beside a continuation row.
- Kept sub-five-column rendering on the previous no-marker fallback to avoid narrow-terminal overflow.

### Why this lives in the fork

- The marker is part of the coding-agent interactive composer layout, including width reservation, wrapping, cursor placement, and autocomplete alignment.
- Extensions can replace the editor but cannot decorate the built-in editor's private render loop without reimplementing its editing behavior.

### Expected upstream merge-conflict zones

- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` around `CustomEditor` construction and rendering.
- `packages/coding-agent/test/custom-editor-prompt.test.ts` around built-in composer rendering assertions.

## 2026-08-01 — Reconcile fork runtime contracts after the upstream merge

### What changed

- Updated Grok themes for the merged scrollbar color contract while preserving their non-palette inheritance.
- Kept implicit legacy `SYSTEM.md` and `APPEND_SYSTEM.md` files excluded from both prompt content and source metadata.
- Restored source-runtime extension aliases, Alt Screen help grouping, and package-declared hook discovery.
- Added the merged protocol and client workspaces to the root build graph in dependency order so clean CI runners produce their declarations before dependent packages compile.
- Updated deterministic test hosts for merged session abort, Markdown transformer, UI mode, fullscreen scrollbar, and offline-network contracts.
- Made the `/btw` concurrent snapshot test wait for the exact side-provider entry signal instead of relying on provider-call timing.

### Why

- Upstream added runtime capabilities and lifecycle requirements on surfaces that also carry fork-only behavior. The merge preserved most production code but omitted three fork integration fields and left several fork tests modeling the pre-merge runtime shape.
- The resulting full package suite had 25 coding-agent failures despite narrower focused suites being green, and clean CI builds could not resolve the newly merged client and protocol workspaces because local validation had pre-existing `dist` artifacts.

### Why this cannot be expressed externally

- These behaviors span package loading, built-in help, manifest parsing, session lifecycle, interactive rendering, and the repository's deterministic faux-provider tests before extension-level customization can repair them.

### Expected merge conflict zones

- `scripts/build-all.mjs`, `src/core/extensions/loader.ts`, `src/core/pi-manifest.ts`, `src/core/resource-loader.ts`, `src/modes/interactive/help-content.ts`, Grok theme JSON, `interactive-mode.ts` test hosts, session-runtime tests, model-network policy tests, and `/btw` concurrency coverage.

## 2026-08-01 — Preserve the no-shipped-shrinkwrap install contract

### What changed

- Removed the upstream `packages/coding-agent/npm-shrinkwrap.json` that was reintroduced by the merge.
- Updated the root supply-chain documentation to identify `publish-deps.lock.json` as the staging-only generated manifest and to state that `npm-shrinkwrap.json` must not ship.

### Why

- The fork deliberately removed the npm shrinkwrap because npm force-packs that filename and treats it as the complete locked bundled tree, skipping non-bundled direct dependencies and leaving installed CLIs broken with `ERR_MODULE_NOT_FOUND`.
- Keeping the reintroduced file or the stale README claim would contradict the existing pack guard and misdirect the next release or upstream merge.

### Why this cannot be expressed externally

- Package tarball contents, publish staging metadata, and repository release documentation are owned before the Senpi runtime and extension system start.

### Expected merge conflict zones

- `packages/coding-agent/npm-shrinkwrap.json`, root `README.md` supply-chain documentation, `scripts/generate-coding-agent-shrinkwrap.mjs`, and publish pack guards.

## 2026-08-01 — Backfill local release and publish hardening

### What changed

- Local release tests build packages first and run smoke tests serially.
- Release output prints the exact npm publish command and permits authenticated local publishing.
- Provenance metadata, publish roots, and publish directories now match the fork's declared package layout.

### Why

- Local release evidence must exercise built artifacts and produce commands that work from the actual fork package roots.

### Why this cannot be expressed externally

- The behavior is owned by repository release, publish, provenance, and smoke-test scripts.

### Expected merge conflict zones

- `scripts/local-release.mjs`, `scripts/publish.mjs`, release smoke helpers, and package publish metadata.

## 2026-07-31 — Claude SDK OAuth provider identity

- Changed: renamed Senpi's SDK-backed Claude subscription provider and every active internal surface from `claude-agent-sdk` to `claude-sdk-oauth`, including auth storage, settings, commands, RPC/app-server account routing, tests, docs, and QA scenarios.
- Preserved: Anthropic's upstream package and platform sidecar names remain `@anthropic-ai/claude-agent-sdk`.
- Coverage: three captured RED→GREEN contracts pin registry/login/path behavior; focused provider tests and real CLI/TUI QA cover the renamed surface.
- Merge-conflict risk: high in the provider directory and its tests; medium in builtin registration and account protocol imports.

## 2026-07-30 — CalVer-aware update ordering

- Changed: package update checks now compare Senpi's `YYYY.M.D-N` same-day revisions using the release contract, where the bare date is revision 1 and `-2`, `-3`, and later suffixes are newer releases.
- Why: npm semver treats `2026.7.30-2` as a prerelease older than `2026.7.30`, so a client on the second same-day release could incorrectly "update" back to the first release.
- Coverage: `test/version-check.test.ts` proves same-day revision ordering, cross-day ordering, and both update-detection directions while preserving normal semver comparisons.
- Merge-conflict risk: low. The change is isolated to the shared package-version comparator and its focused tests.

## 2026-07-30 — Root-owned consumer sidecar installation (#446)

- Changed: publish staging now removes promoted platform optional-dependency edges from the bundled portable package manifest after copying the complete family to Senpi's root optional dependencies.
- Why: npm 11 placed `claude-agent-sdk-darwin-arm64` for the root and bundled SDK edges but never fetched its tarball, leaving an invalid empty directory. A fresh `2026.7.29-5` install therefore still failed native resolution even though the universal tarball contained zero platform sidecar files.
- What changed: the literal issue-446 test proves the root retains all eight Claude platform optionals while the staged bundled SDK owns none, so npm has one consumer-resolved edge and downloads the real Darwin executable.
- Why the extension system could not handle this: npm synthesizes the invalid empty dependency directory before Senpi or its provider runtime starts.
- Merge-conflict risk: low. Expected conflict zones are publish-manifest staging and the focused issue-446 packaging test.

## 2026-07-30 — Strip publisher-native packages before npm pack (#446)

- Changed: after promoting complete platform optional-dependency families into the root manifest, publish staging now removes every platform-constrained package directory before npm traverses bundled dependency graphs.
- Why: excluding the Linux sidecar from `bundleDependencies` was not sufficient. npm still followed the bundled portable Claude SDK's installed optional dependency and physically embedded the publisher's `claude-agent-sdk-linux-x64` files in the universal tarball.
- What changed: the literal issue-446 test now runs real `npm pack --dry-run` and asserts the Linux sidecar path is absent, while the consumer optional contract remains intact for darwin-arm64 installation.
- Why the extension system could not handle this: the publisher-native files were already baked into the npm artifact before install or runtime extension loading.
- Merge-conflict risk: low. Expected conflict zones are publish-manifest staging and the focused issue-446 packaging test.

## 2026-07-30 — Publish gate honors consumer-resolved platform optionals (#446)

- Changed: `assertSenpiPackedWorkspaceFiles()` now validates the staged `bundleDependencies` contract when it is available, while retaining the legacy all-runtime fallback for callers without a staged manifest.
- Why: issue #446 intentionally promotes complete native optional-dependency families into the published root manifest so npm can select the consumer platform. The publish-only workflow still treated those non-bundled optionals as missing vendored files and stopped before npm publication.
- What changed: `publish.mjs` passes the staged bundle list into the pack assertion, and focused RED→GREEN coverage proves a bundled portable Claude SDK may omit the consumer-resolved `darwin-arm64` package from the universal tarball.
- Why the extension system could not handle this: the failure occurs in npm tarball validation before package publication or runtime extension loading.
- Merge-conflict risk: low. Expected conflict zones are the publish pack assertion, `publish.mjs`, and the focused packaging test.

## 2026-07-29 — Consumer-resolved Claude Agent SDK sidecars (#446)

- Changed: publish-manifest staging now promotes a bundled package's complete platform-specific optional dependency family into the root `@code-yeongyu/senpi` manifest while continuing to exclude the publish runner's materialized native package from `bundleDependencies`.
- Why: the universal npm tarball bundled `@anthropic-ai/claude-agent-sdk-linux-x64` from the Linux publish runner. npm did not re-resolve the bundled SDK's nested optional dependencies on install, so Apple Silicon consumers received no `darwin-arm64` Claude executable and the provider failed before authentication.
- What changed: extracted publish-manifest construction into `scripts/prepare-senpi-publish-manifest.mjs`, kept workspace staging and pack checks in `prepare-senpi-bundled-workspaces.mjs`, split the oversized packaging test suite by responsibility, and added issue #446 plus unreadable-manifest RED→GREEN coverage. A real local release installed only `claude-agent-sdk-darwin-arm64` on this Mac and resolved its `claude` binary with `CLAUDE_CODE_EXECUTABLE` unset.
- Why the extension system could not handle this: npm dependency bundling and consumer-side optional dependency resolution happen before the Senpi runtime and extension loader start.
- Merge-conflict risk: low. Expected conflict zones are publish-manifest staging and the colocated packaging tests; runtime provider code is unchanged.

## 2026-07-29 — OpenAI Codex usage extension example

- Changed: added a standalone `examples/extensions/openai-codex-usage/` example that resolves Senpi-managed Codex OAuth, fetches the remaining five-hour and weekly limits, and publishes them through `ctx.ui.setStatus()`. Missing windows render as unavailable; sanitized HTTP/network/parse failures replace stale values with an unavailable status. The poller is single-flight, abortable, and cleared on model changes, shutdown, or `/usage`.
- Why: users can see provider limits with the built-in footer or any custom footer that consumes extension statuses, without coupling usage retrieval to one footer implementation or presenting unknown/stale percentages as current.
- Extension boundary: the example uses public model-registry, lifecycle, command, and status APIs; no core footer or authentication source changes are required. Deterministic fake-API and fake-timer tests cover toggle, model-change, abort, scheduled polling, and shutdown cleanup.
- Merge-conflict risk: low. The change adds an isolated example directory, one test, one catalog row, documentation, and this record.

## 2026-07-28 — Billing-class provider errors always pin the session model swap

- Changed: billing-class failures (credit balance, insufficient quota) engage the fallback chain with the pinned `"billing"` reason unconditionally — the candidate becomes the session model for the rest of the session and never auto-reverts. Files: `src/core/retry-fallback/billing.ts` (classifier), `src/core/retry-fallback/controller.ts` (billing reason pins and notes the cooldown), `src/core/agent-session.ts` (classifies hard-error-eligible failures). Non-billing hard errors keep the temporary, revertable switch. Supersedes the opt-in `retry.billingErrorPolicy` variant of the same change; the setting no longer exists.
- Why: a credit-exhausted account never recovers within a session, but the ordinary hard-error fallback reverted to the dead model after the 30-minute billing cooldown, killing later turns. Observed in a real session (anthropic-api claude-fable-5, 2026-07-28): the turn died with a 400 "credit balance is too low".
- Coverage: `test/suite/retry-fallback-billing-swap.test.ts` (billing errors pin and hold past the cooldown with default settings, non-billing hard errors stay temporary, classifier table) and `test/suite/retry-fallback-hard-error.test.ts` (insufficient-quota fixture now reports the billing reason).
- Merge-conflict risk: low. Additive union members and one engagement branch; the controller's reason handling is the expected conflict zone.

## 2026-07-26 — Resolve Bun dependencies through fork-owned aliases (#230)

- Changed: `scripts/publish.mjs` stages the four upstream-named private source
  packages as `@code-yeongyu/senpi-ai`, `@code-yeongyu/senpi-agent-core`,
  `@code-yeongyu/senpi-tui`, and `@code-yeongyu/senpi-pty`, alongside
  `@code-yeongyu/senpi-codemode` and `@code-yeongyu/senpi`. The source package
  manifests retain `private: true` and their `@earendil-works/*` names.
- Why: Bun resolves declared dependencies from npm and ignores npm's
  `bundleDependencies`, while the upstream-owned `@earendil-works` namespace
  neither grants this fork publish access nor contains the fork's lockstep
  versions. Removing those dependency keys makes npm omit their bundled copies.
- What changed: the staged senpi manifest preserves each original dependency
  key so npm packs it at the source import path, but rewrites its spec to an
  npm alias targeting the matching `@code-yeongyu/senpi-*` package. Bun fetches
  only the owned alias; npm retains and resolves the bundled original package.
  The code source imports stay unchanged, and `@code-yeongyu/senpi-server`
  remains private.
- Merge-conflict risk: low. `scripts/publish.mjs` temporary manifest staging
  and `stagePublishManifest()` alias rewriting are the expected conflict zones.

## 2026-08-12 — app-server extension RPC coverage and documentation

- Changed: added focused app-server suites for extension event audience/one-frame delivery and request round-trips with
  unknown and duplicate handler errors; documented the additive method and notification wire shapes.
- Why: app-server had no executable contract for the existing extension-owned RPC channel, even though classic RPC did.
- What changed: `test/suite/app-server-extension-events.test.ts`,
  `test/suite/app-server-extension-requests.test.ts`, `docs/app-server.md`, and the package `CHANGELOG.md` now cover the
  real runtime surface and release note with isolated temporary extension directories and no network or credentials.
- Why the extension system could not handle this: tests and public protocol documentation describe the host connection
  boundary; an extension cannot install or verify those repository-level contracts.
- Merge-conflict risk: low. The focused test files are new; the supported-method and notification sections in
  `docs/app-server.md` are the only shared conflict zones.

## 2026-07-22 — app-server runtime import test without npm subprocess

- Changed: `test/suite/app-server-protocol.test.ts` now executes its runtime `.js` import probe with
  `node --import tsx --eval` instead of `npx tsx -e`.
- Why: npm configuration warnings are unrelated to the protocol import contract but are emitted on the spawned
  subprocess stderr in CI, making the otherwise-successful test fail.
- What changed: test runner invocation only; the imported module, assertions, and runtime behavior are unchanged.
- Why the extension system could not handle this: this is hermetic package test infrastructure, not runtime extension
  behavior.
- Merge-conflict risk: low. The only conflict zone is the subprocess invocation in the focused protocol metadata test.

## 2026-07-22 — Fully self-contained publish tarball (npm packaging MODULE_NOT_FOUND fix)

- Changed:
  - `scripts/prepare-senpi-bundled-workspaces.mjs`
  - `scripts/prepare-senpi-bundled-workspaces.test.mjs`
  - `scripts/prepare-senpi-bundled-workspaces.prepare.test.mjs`
  - `scripts/publish.mjs`
  - `scripts/AGENTS.md`
- Why: fresh `npm i -g @code-yeongyu/senpi` (both 2026.7.20-2 and 2026.7.22) nondeterministically
  dropped registry runtime deps (cross-spawn, which, @modelcontextprotocol/sdk), leaving the CLI
  dead with ERR_MODULE_NOT_FOUND. The publish tarball vendored only the 5 bundled workspace
  packages + their closure; npm arborist, forced to fetch the remaining 39 runtime deps from the
  registry, could hit ETARGET on the registry-absent `^2026.x` workspace specs and abort reify
  mid-flight, leaving a half-installed tree.
- What changed: staging now vendors the ENTIRE runtime closure (all registry deps + transitives
  from `publish-deps.lock.json`, as before via `copyPublishDependencies`) and
  `stagePublishManifest` rewrites the publish manifest at staging time so `bundleDependencies`
  (and the `bundledDependencies` alias) lists every staged package. All `dependencies` edges —
  including the 5 `^2026.x` workspace specs — are preserved; with the complete bundle npm needs
  no registry fetch at install time. `stagePublishManifest` also rejects `file:`/`link:`/
  `workspace:` specs and any declared runtime dep missing from the staged node_modules.
  `assertSenpiPackedWorkspaceFiles` gained a `runtimeDependencies` pack check (wired in
  `scripts/publish.mjs`) so a tarball missing any vendored runtime dep fails before publish.
  `publish-deps.lock.json` remains staging-only and is never shipped; no new lifecycle-script
  dependencies were added.
- Merge-conflict risk: low. Release tooling only; no runtime source touched.

## 2026-07-21 — Codex HEAD app-server parity documentation refresh

- Changed:
  - `docs/app-server.md`, `src/modes/app-server/AGENTS.md`, and the package changelog: documented the final
    capability-mapped Codex HEAD surface, protocol provenance, intentionally unsupported requests, and the
    source-oracle differential harness.
- Why: integrations need an accurate compatibility boundary. The prior inventory still described implemented
  parity methods as unavailable and did not explain deliberate differences such as restart-time history
  reconstruction, aggregated diffs, the settings subset, or honest account reads.
- What changed: documentation and its hermetic documentation checker only; no app-server runtime behavior changed.
- Why the extension system could not handle this: protocol compatibility, runtime invariants, and QA-harness
  operation are package-level contracts rather than extension behavior.
- Merge-conflict risk: low. The primary conflict zone is the app-server capability table when the Codex protocol
  pin changes again.

## 2026-07-20 — Codex HEAD app-server facade and contract fixtures

- Changed:
  - `src/modes/app-server/protocol/` and related app-server runtime seams: added the handwritten Node-compatible facade,
    HEAD method/experimental-notification catalogs, populated notification envelopes, deferred post-response actions,
    and the canonical terminal error/completion pair.
  - `test/fixtures/app-server-methods-codex-head.json`, app-server facade/error/notification/dispatch/terminal suites, and
    the QA capability manifest: pin the source-derived catalogs and the intended wire behavior without importing the
    generated tree at runtime. The source-driven QA probes also assert that notification timestamps survive transport
    serialization while approval server requests remain unstamped.
- Why: Codex's generated TypeScript exporter intentionally excludes experimental request roots, while Senpi still needs
  a complete typed contract for the capability-mapped parity work and evidence that catalog or envelope drift fails
  loudly.
- What changed: protocol/runtime/test surface only; the generated Codex fixture remains byte-identical and the existing
  remote-control response is intentionally left for its later implementation task.
- Why the extension system could not handle this: app-server method registration, transport envelopes, and JSON-RPC
  frame ordering happen below the extension API.
- Merge-conflict risk: low. The app-server tree and HEAD fixture are fork-only; on a future Codex pin, regenerate evidence
  first and then re-derive the handwritten facade.

## 2026-07-21 — config-reload settings-manager seam

- Changed: `src/core/settings-manager.ts` tracks recent process-written settings content hashes by absolute path, with bounded, expiring, consume-on-match entries shared across settings-manager and storage instances.
- Why: the default-on config-reload builtin must ignore its own settings writes without suppressing a later identical external edit or losing rapid consecutive writes.
- What changed: the exported `wasSelfWrite()` query and path helpers are fork-specific storage seams; the `configReload` setting augmentation remains owned by the builtin so core settings semantics stay unchanged when the builtin is unused.
- Why the extension system could not handle this: the persistence write path is owned by `FileSettingsStorage` and `InMemorySettingsStorage`, outside extension lifecycle hooks.
- Merge-conflict risk: medium around settings storage writes and exported settings-manager helpers.

## 2026-07-20 — paced streaming tool argument preview coverage

- Changed:
  - `test/tool-args-reveal.test.ts`: deterministic fake-timer coverage for initial visibility, monotonic catch-up,
    64-unit parse batching, surrogate-safe slicing, exact per-call/all-call flushes, disabled-setting cancellation, and
    live FPS refreshes.
  - `test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts`: extends the prototype harness with the
    tool-argument reveal flush seam used when pending components are rebuilt.
  - `test/interactive-mode-status.test.ts`: extends the active-tool lifecycle fixture with the tool-argument reveal
    flush/finish seams and direct exact-argument update surface.
- Why: streamed tool arguments need the same stable cadence as assistant text without exposing malformed Unicode or
  allowing a stale timer to overwrite exact execution arguments.
- What changed: focused package test coverage; runtime changes are tracked in the nearest `src/**/changes.md` files.
- Why the extension system could not handle this: the tests pin private interactive pending-tool and timer lifecycles.
- Merge-conflict risk: low. The suite and controller are fork-only; runtime wiring risk is documented under `src/`.

## 2026-07-20 — smooth streaming reveal test coverage

- Changed:
  - `test/streaming-reveal.test.ts`: deterministic coverage for incremental grapheme counting and slicing, display
    message construction, fps-invariant reveal timing, and controller lifecycle behavior.
  - `test/settings-manager.test.ts`: defaults, clamping, and persistence coverage for smooth-streaming settings.
  - `test/interactive-mode-compaction-queue-session-rebind.test.ts`: session-rebind test doubles now include the reveal
    controller `stop` seam so the full CI suite exercises the updated `InteractiveMode` shape.
- Why: the interactive reveal must remain Unicode-safe and time-based across 30–120fps, including live setting and
  visibility changes.
- What changed: test-only package surface; runtime changes are tracked in the nearest `src/**/changes.md` files.
- Why the extension system could not handle this: the tests exercise private built-in TUI lifecycle and settings state.
- Merge-conflict risk: low. Both suites are focused additions to the package test surface.

## 2026-07-07 — pi-pty workspace dependency groundwork

- Changed:
  - `package.json` (+ `npm-shrinkwrap.json`, `install-lock/package-lock.json`): added the fork's
    `@earendil-works/pi-pty` workspace package to `dependencies` and `bundledDependencies`.
- Why: groundwork for the persistent-terminal tool; the native PTY runtime (`packages/pty`, `crates/senpi-pty`) is
  fork-native and ships bundled like the other workspace packages.
- What changed: dependency wiring only; no coding-agent runtime files consume it yet.
- Why the extension system could not handle this: bundled workspace dependencies are package-level release surface.
- Merge-conflict risk: low. `dependencies` / `bundledDependencies` lists in `package.json`.

## 2026-07-07 — MCP W1 package surface (dependency, tests, fixtures)

- Changed:
  - `package.json` (+ `npm-shrinkwrap.json`, `install-lock/package-lock.json`): exact-pinned
    `@modelcontextprotocol/sdk` dependency.
  - `test/mcp/**`: MCP test fixtures with chaos knobs (`stdio-server.ts`, `http-server.ts`, `sdk-server.ts`,
    `spawn-fixture.ts`, schema goldens) and suites covering config/security, transport, connection, service
    lifecycle, registration/call semantics, exposure policy, `/mcp` commands, instructions injection, log redaction,
    and async wrap behavior.
- Why: the MCP W1 builtin (see `src/core/extensions/builtin/mcp/changes.md`) needs deterministic, token-free
  end-to-end coverage against real stdio/http servers, including failure injection.
- What changed: fork-only test/fixture surface plus the pinned SDK dependency; no runtime files outside
  `builtin/mcp/` and `builtin/index.ts`.
- Why the extension system could not handle this: package dependencies and the test harness are package-level
  surfaces.
- Merge-conflict risk: low. `test/mcp/` does not exist upstream; the dependency pin only conflicts if upstream ever
  adopts the MCP SDK.

## 2026-07-06 — app-server and neo docs/test surface

- Changed:
  - `docs/app-server.md`, `docs/neo.md`: protocol/activation documentation for the fork's app-server mode and the neo
    daemon (process-isolation rationale included).
  - App-server test suites (transports, thread lifecycle, approvals, projection, daemon supervision) and neo test
    suites (`neo-daemon-mode`, `neo-auth-rpc`, `neo-args-parse`, `neo-argv`, registry self-heal, spawn-race
    convergence).
- Why: both features are fork-native modes (see `src/changes.md`, `src/modes/rpc/changes.md`); docs and tests pin
  their wire contracts and daemon semantics.
- What changed: documentation and test additions only at the package root; runtime changes are tracked in the
  per-directory changes.md files.
- Why the extension system could not handle this: package docs and the test harness are package-level surfaces.
- Merge-conflict risk: low. The docs and suites are fork-only files.

## 2026-07-02 — upstream extension renderer docs and regression sync

- Changed:
  - `docs/extensions.md`
  - `docs/sdk.md`
  - `docs/session-format.md`
  - `examples/extensions/README.md`
  - `examples/extensions/entry-renderer.ts`
  - `test/auth-storage.test.ts`
  - `test/extensions-discovery.test.ts`
  - `test/extensions-runner.test.ts`
  - `test/model-resolver.test.ts`
  - `test/session-manager/build-context.test.ts`
  - `test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts`
- Why: The upstream sync adds extension entry renderers, public model-resolution helpers, auth-save failure reporting,
  split-turn compaction serialization, and bash timeout validation. The docs, example extension, and tests document and
  pin those user-visible behaviors for the fork.
- What changed: Accepted upstream docs/examples/tests for the synced behaviors while preserving fork-specific runtime
  expectations such as compaction detail propagation and model-resolution warning behavior.
- Why the extension system could not handle this: these are documentation, example, and regression-test updates for the
  package API and runtime behavior; extensions can consume the API, but they cannot document or verify package-level
  contracts.
- Merge-conflict risk: low to medium. Expected conflict zones are the extension renderer docs/example, model-resolution
  SDK docs, and focused regression assertions if upstream revises these APIs again.

## 2026-05-15 — stop rebuilding linked `senpi` on launch

- Changed:
  - `scripts/build-all.mjs`
  - `scripts/create-root-senpi-wrapper.mjs`
  - `scripts/create-root-senpi-wrapper.test.mjs`
- Why: The PATH-visible `senpi` command should not pay a build cost every time it starts. Build/link should create or refresh the shim, and regular launches should only execute the already-built CLI.
- What changed: Removed the git HEAD stamp, source mtime scan, dist marker check, and launch-time `scripts/build-all.mjs` call from the generated root wrapper. The build helper now also deletes the legacy `.senpi-build-head` marker when refreshing `dist/senpi`.
- Why the extension system could not handle this: this happens in the PATH shim before the coding-agent runtime or extension loader starts.
- Merge-conflict risk: low. The expected conflict zone is `scripts/create-root-senpi-wrapper.mjs` if upstream changes local build/link behavior.

## 2026-05-15 — rebuild stale linked CLI before launching `senpi`

- Changed:
  - `scripts/build-all.mjs`
  - `scripts/create-root-senpi-wrapper.mjs`
  - `scripts/create-root-senpi-wrapper.test.mjs`
- Why: The PATH-visible `senpi` shim runs the root `dist/senpi` wrapper. If source changes were committed but the workspace dist artifacts were not rebuilt, the linked command could still execute stale `packages/*/dist` code and reproduce fixed bugs.
- What changed: The root build writes the git HEAD it built into `dist/.senpi-build-head`. The generated root wrapper now rebuilds when that stamp is missing or stale, when required dist markers are missing, or when relevant workspace source/package/script mtimes are newer than the build stamp. In a git checkout, if any check says the linked build is stale, it runs `scripts/build-all.mjs` before launching `packages/coding-agent/dist/senpi`.
- Why the extension system could not handle this: stale dist is a build/link packaging problem that occurs before the runtime extension system starts.
- Merge-conflict risk: low. The expected conflict zone is `scripts/create-root-senpi-wrapper.mjs` if upstream changes the local build/link shim.

## 2026-05-13 — copy all non-TypeScript resources into dist via copy-assets

- Changed: `packages/coding-agent/package.json`
- Why: `tsgo` does not copy non-`.ts` assets into `dist/`, but `scripts/build-binaries.sh` expects interactive theme JSON files, PNG assets, and export-html templates to exist there when packaging release binaries. The previous fix only copied theme JSON, so CI still failed on missing `dist/modes/interactive/assets/*` and `dist/core/export-html/`.
- What changed: Replaced the inline theme-only copy in the `build` script with `npm run copy-assets`, which already covers theme JSON, PNG assets, and export-html templates + vendor JS in one step.
- Merge-conflict risk: low. The expected conflict zone is the `build` script in `packages/coding-agent/package.json` if upstream changes packaging flow.

## 2026-05-12 — add pi-todotools to builtin sync

- Changed:
  - `packages/coding-agent/scripts/sync-builtin-extensions.mjs`
  - `packages/coding-agent/src/core/extensions/builtin/external-versions.json`
  - `README.md`
- Why: The todo tools now live in the public sibling `../pi-extensions/pi-todotools` repository, but senpi should continue to ship them as a builtin.
- What changed: Added sync mappings and documentation for the vendored `todowrite` builtin source.
- Merge-conflict risk: low. Expected conflict zones are the builtin sync file list, external version manifest, and README builtin tables.

## 2026-04-05 — add `senpi` CLI alias

- Changed: `packages/coding-agent/package.json`
- Why: The user wants the built CLI to be directly runnable via `senpi`. This cannot be implemented through the extension system because shell command exposure is controlled by the package `bin` map, not runtime extension hooks.
- What changed: Added a second CLI bin alias, `senpi`, pointing at the existing `dist/cli.js` entrypoint alongside `pi`.
- Merge-conflict risk: low. The only expected conflict zone is the `bin` field in `packages/coding-agent/package.json` if upstream changes CLI entrypoint names or packaging layout.

## 2026-04-09 — fix stale coding-agent baseline test expectations

- Changed:
  - `packages/coding-agent/test/resource-loader.test.ts`
  - two legacy permission suite files
- Why: upstream and prior fork work changed the builtin extension set, removed `SYSTEM.md` / `APPEND_SYSTEM.md` discovery, and split tool-call permission blocking into `permission-system`. The pre-existing tests were asserting the old behavior and kept the coding-agent Vitest suite red.
- What changed:
  - Updated `resource-loader.test.ts` to account for the current builtin extension identifiers, builtin `/tui` command presence, always-loaded builtin extensions during command-collision scenarios, and the intentional absence of `SYSTEM.md` / `APPEND_SYSTEM.md` loading.
  - Updated the legacy integration coverage to assert that denied tool calls are no longer blocked directly outside `permission-system`.
  - Updated the legacy permission coverage to exercise the current `permission-system` extension behavior for deny, allow, ask-without-UI, and `Allow always` flows.
- Why the extension system could not handle this: these failures were stale assertions in test files. No runtime extension could correct incorrect test expectations without changing the tests themselves.
- Merge-conflict risk: medium. The likely conflict zones are the affected assertion blocks in those three test files if upstream changes resource loading, builtin registration, or permission-system behavior again.

## 2026-04-12 — emit a callable `senpi` artifact from the standard build

- Changed:
  - `packages/coding-agent/package.json`
  - `package.json`
  - `scripts/create-root-senpi-wrapper.mjs`
- Why: The user wants root-level `npm run build` to be sufficient in the same practical sense that `senpi` was: after building, there should be a directly callable `senpi` command, not just an internal package artifact. A plain copied file in root `dist/` was not enough for `which senpi`; the build also needed to refresh a PATH-visible shim.
- What changed:
  - Updated the coding-agent `build` script to emit `dist/senpi` alongside `dist/cli.js`.
  - Updated the root `build` script to generate a root `dist/senpi` wrapper that delegates to `packages/coding-agent/dist/cli.js`.
  - Added a small build helper at `scripts/create-root-senpi-wrapper.mjs` to write that root wrapper.
  - Updated the root build helper to also write a small `senpi` shim into npm's global `bin/` directory, so `which senpi` resolves after a successful root build.
- Why the extension system could not handle this: root build orchestration, emitted files, and PATH-visible shim installation are packaging concerns controlled by package scripts, not runtime extensions.
- Merge-conflict risk: low to medium. The likely conflict zones are the root `scripts.build` line, the coding-agent `scripts.build` line, the build helper script, and this fork note if upstream changes packaging flow or build helpers.

## 2026-04-17 — drop external `uuid` dep by inlining UUIDv7 generation

- Changed:
  - `packages/coding-agent/src/core/session-manager.ts`
  - `packages/coding-agent/package.json`
- Why: Upstream (commit 018b40c3) switched session id generation to `uuidv7()` from the `uuid` npm package and added `"uuid": "^11.1.0"` to `dependencies`. Downstream consumers of `@code-yeongyu/senpi` (including Sionic Storm's carrier-ordersheet tooling) were hitting runtime failures in `subscription-control.test.ts` and `headless-runtime.test.ts` because `dist/core/session-manager.js` could not resolve `"uuid"` when the consumer's install did not hoist the transitive dep. This bricks any consumer that bundles only the built `dist/` tree or uses a package-lock that predates the `uuid` addition.
- What changed:
  - Replaced the `import { v7 as uuidv7 } from "uuid"` call with a ~15-line inline UUIDv7 generator built on Node's stock `crypto.randomBytes`. Format conforms to RFC 9562 (version nibble `0x7`, variant bits `10`), preserves millisecond-granularity time ordering (still honors the original intent from upstream #3018: session id routing affinity), and uses no external packages.
  - Removed `"uuid": "^11.1.0"` from `dependencies`, eliminating the transitive requirement entirely.
- Why the extension system could not handle this: session id generation runs inside core `SessionManager` before any extension context exists. Extensions cannot patch an `import` in `dist/`, and consumers hit the failure before any extension hook fires.
- Merge-conflict risk: medium. The expected conflict zones are `packages/coding-agent/src/core/session-manager.ts` lines ~1-45 (imports + inline `uuidv7` helper) and `packages/coding-agent/package.json` `dependencies` block if upstream changes the `uuid` version or adds a different session id generator. On the next upstream sync, the resolution is: keep this fork's inline implementation; do NOT re-add `"uuid"` to dependencies.

## 2026-04-17 — make monorepo build cleanly under npm, bun, and pnpm (consolidated)

- Changed:
  - `package.json` (root)
  - `packages/agent/package.json`
  - `packages/ai/package.json`
  - `packages/coding-agent/package.json`
  - `packages/web-ui/package.json`
  - `pnpm-workspace.yaml` (new)
  - `scripts/build-all.mjs` (new)
  - `scripts/run-web-ui-check.mjs` (new)
  - `.npmrc` temporarily added then removed in favor of `pnpm-workspace.yaml` camelCase keys
- Why: The original layout relied exclusively on npm's flat/hoisted install to satisfy cross-workspace transitive imports, and the root `build` / `check` scripts hardcoded `npm run X` while cd-ing through packages. That meant:
  - bun and pnpm both refused to install because several workspaces imported modules they did not declare as direct deps, and the root `package.json` still carried a stale `"@code-yeongyu/senpi": "^0.30.2"` dependency from the rename from `@mariozechner/pi-coding-agent`.
  - Under pnpm/bun, every nested `npm run X` inside a root build spewed `npm warn Unknown env config ...` for each pnpm-only `npm_config_*` env var (`node_linker`, `link_workspace_packages`, etc.) that pnpm/bun exposed to child processes.
  - bun's default install blocked postinstalls for native addons (`@parcel/watcher`, `koffi`, `protobufjs`), and pnpm 10 blocked the same plus `canvas` and `esbuild`, printing approval prompts on every install.
- What changed:
  - Root `package.json`: removed orphaned `"@code-yeongyu/senpi": "^0.30.2"` from `dependencies` (forcing bun to 404 against the public npm registry before workspace resolution ever ran). Replaced the hardcoded `"build": "cd packages/tui && npm run build && ..."` with `"build": "node scripts/build-all.mjs"`, and replaced `"check": "... && npm run check:browser-smoke && cd packages/web-ui && npm run check"` with a `node`-based invocation plus `node scripts/run-web-ui-check.mjs`. Added `trustedDependencies` (for bun) and `pnpm.onlyBuiltDependencies` (for pnpm) to preapprove the postinstall scripts bun and pnpm would otherwise block.
  - Added missing direct dependencies that are used in `src/`:
    - `packages/agent/package.json`: `@sinclair/typebox` (used in `src/types.ts`).
    - `packages/ai/package.json`: `@smithy/node-http-handler`, `@smithy/types` (used in `src/providers/amazon-bedrock.ts`), and `yaml` (used in `src/tool-call-middleware/protocols/yaml-xml.ts`, which is a fork-only file). Also replaced the nested `"build": "npm run generate-models && tsgo ..."` with `"prebuild": "tsx scripts/generate-models.ts"` + `"build": "tsgo -p tsconfig.build.json"` so the parent PM — not an npm subprocess — runs the pre hook.
    - `packages/coding-agent/package.json`: `@sinclair/typebox` (used throughout `src/core/tools/*`). Split the asset-copy step out of `build` into a `postbuild` hook and removed the redundant `copy-assets` script (it was unused after the split). Collapsed `build:binary` down to a bun-only sequence and removed its `npm --prefix` recursion so it runs without npm warnings when the user is on bun.
    - `packages/web-ui/package.json`: `@mariozechner/pi-agent-core`, `@sinclair/typebox`, `highlight.js` (used in the artifact renderers), and `tailwindcss` as a devDep (pulled in transitively by `@tailwindcss/cli` under npm hoisting, invisible under bun/pnpm isolation).
  - Added `pnpm-workspace.yaml` with the exact workspace list plus pnpm 10 camelCase behavior keys: `nodeLinker: hoisted` (mirrors npm's flat install so transitive imports keep resolving across workspaces without a broader direct-dep audit), `linkWorkspacePackages: deep` + `preferWorkspacePackages: true` (pnpm 10 otherwise tries to fetch `@code-yeongyu/senpi` from the public npm registry), and `onlyBuiltDependencies` (pre-approves the five native-addon postinstalls pnpm would otherwise skip). Keeping the pnpm config in `pnpm-workspace.yaml` instead of `.npmrc` avoids leaking pnpm-only keys into npm as env vars that npm then warns about.
  - Added `scripts/build-all.mjs`: PM-agnostic orchestrator that detects the parent package manager via `$npm_execpath` / `$npm_config_user_agent`, strips the known pnpm-only `npm_config_*` env keys before spawning children, and runs `<pm> run build` in each workspace in dependency order. The companion `scripts/run-web-ui-check.mjs` does the same for `packages/web-ui`'s `check`.
- Why the extension system could not handle this: package-manager compatibility, install layout, root build orchestration, and postinstall approval lists are all controlled by package/workspace config files and spawn-time env, none of which a runtime extension can intercept.
- Merge-conflict risk: low to medium per file. Expected conflict zones are the `dependencies`/`scripts` blocks of the five modified `package.json` files, the new settings and `packages` list in `pnpm-workspace.yaml`, and the orchestrator scripts. On the next upstream sync: (1) keep the fork's `scripts/build-all.mjs` and `scripts/run-web-ui-check.mjs`; (2) keep the `trustedDependencies` / `pnpm.onlyBuiltDependencies` entries in root `package.json`; (3) merge additional workspace packages upstream adds into `pnpm-workspace.yaml`; (4) keep the added direct deps in the five package.json files unless upstream inlines equivalent deps.

## 2026-07-22 — RPC supported-thinking-level contract tests

- Changed: added hermetic RPC coverage for synthetic reasoning, non-reasoning, and explicit `xhigh: null` model fixtures.
- Why: RPC clients need a stable model-level capability contract before rendering thinking-level controls.
- What changed: test-only package coverage; runtime seams are documented in the matching core and RPC change logs.
- Why the extension system could not handle this: the RPC process, wire response, and model registry are package-owned surfaces.
- Merge-conflict risk: low. The test file is fork-only.

## 2026-08-02 — TypeScript native tsc migration

### What changed

- Replaced `tsgo` with `tsc` in the `dev` and `build` scripts; flags and arguments remain unchanged.
- Bumped the root `typescript` pin from `6.0.3` to `7.0.2`.
- Dropped the `@typescript/native-preview` toolchain dependency.
- Added `@typescript/typescript6@6.0.2` (Microsoft's official TypeScript-6 API bridge) so `scripts/check-ts-relative-imports.mjs` keeps working: TypeScript 7 removed the classic programmatic JS API it imported.
- Added `@typescript/native: npm:typescript@7.0.2` as a scoped alias. The `typescript6` package publicly depends on `@typescript/old` (typescript 6.x), and npm hoists it; alphabetically `@typescript/old` beats `typescript` for the `node_modules/.bin/tsc` link, which would make every bare `tsc` invocation (root check and all package builds) silently run the TypeScript 6 compiler. The alias sorts after `@typescript/old`, so it deterministically wins the `.bin/tsc` link to the 7.0.2 native compiler. It is a bin-ownership pin, not an import target.

### Why

- Adopt a stable-first toolchain policy: use the released `typescript@7.0.2` native compiler for package builds and typechecks instead of the experimental `tsgo` dev build.
- The `native-preview` compiler has been retired upstream in favor of `typescript@next`.

### Why this cannot be expressed externally

- Build scripts and `devDependencies` are package infrastructure, not runtime behavior; extensions cannot rewrite another package's manifest scripts or compiler selection.

### Expected merge conflict zones

- `package.json` `scripts` and `devDependencies` versus upstream `tsgo` usage.
