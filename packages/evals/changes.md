# changes — evals

Tracker for `packages/evals` divergence from upstream `badlogic/pi-mono`.

## Repository-wide upstream divergence audit (2026-08-17)

### What changed

Canonical backfill seeded from the pre-backfill audit report under
`local-ignore/qa-evidence/20260817-changes-md-audit/pre-backfill-audit.json`
(upstream pin `badlogic/pi-mono` `v0.84.2`, `914cf1472e715297caa30db4b9535d534a9eb718`):

- `packages/evals/package.json`: workspace renamed `@earendil-works/pi-evals` ->
  `@code-yeongyu/senpi-evals` (private, CalVer `2026.7.25`); the coding-agent devDependency
  retargeted to `@code-yeongyu/senpi` `^2026.8.16` with `@earendil-works/pi-ai` kept at
  `^2026.8.16`; pinned toolchain bumps (`typescript` `7.0.2`, `vitest` `4.1.10`,
  `@types/node` `26.1.1`).
- `packages/evals/src/pi-harness.ts`: harness imports the coding agent from
  `@code-yeongyu/senpi` instead of `@earendil-works/pi-coding-agent`, and applies
  `transformSystemPrompt` by binding and replacing `services.resourceLoader.getSystemPrompt`
  after `createAgentSessionServices` construction rather than passing upstream's
  `resourceLoaderOptions.systemPromptOverride` constructor seam (see the focused section
  below).
- `packages/evals/vitest.config.ts`: resolve alias retargeted from
  `@earendil-works/pi-coding-agent` to `@code-yeongyu/senpi`, still pointing at
  `workspaceSourcePaths.codingAgentIndex` so evals execute against workspace source.

### Why

- Behavioral evals must exercise the exact Senpi coding-agent build the fork ships, resolved
  under its published `@code-yeongyu/senpi` name against workspace source, not the upstream
  registry artifact. The package identity, dependency graph, and vitest alias therefore all
  carry the fork rename together.

### Why an extension could not handle it

- The harness constructs isolated real agent sessions in temp workspaces before any user
  extension exists, and explicitly fails a run whose session starts with extensions loaded.
  Wiring package identity, dependency resolution, or the system-prompt override through the
  extension system would violate the isolation the eval contract asserts.

### Expected merge conflict zones

- HIGH: the import block and services-construction block in
  `packages/evals/src/pi-harness.ts`; upstream still evolves the
  `resourceLoaderOptions.systemPromptOverride` seam that the fork's loader-level override
  replaced.
- MEDIUM: name/version lines in `packages/evals/package.json` on every CalVer bump or upstream
  dependency refresh.
- LOW: the single alias line in `packages/evals/vitest.config.ts`.

## Senpi package rename and resource-loader system-prompt override (2026-08-01)

### What changed

- The comparative Pi eval harness landed 2026-07-27..2026-07-30 (`32f3a9728` and follow-ups)
  and was reconciled onto the Senpi package rename in the 2026-08-01 upstream sync
  (`13a5f8fe4`), producing the current state recorded in the canonical section above.
- System-prompt transformation mechanics: upstream's pin-era harness passed
  `resourceLoaderOptions: { systemPromptOverride: () => transformedSystemPrompt }` into
  `createAgentSessionServices`. Senpi's `DefaultResourceLoaderOptions` carries no
  `systemPromptOverride` seam, so the fork's harness instead captures
  `services.resourceLoader.getSystemPrompt` bound to the loader, replaces it with a closure
  returning the transformed prompt (falling back to the default), and calls
  `session.reload()` after computing the transform from the session's composed default prompt.

### Why

- Senpi's resource loader intentionally does not expose upstream's constructor-level prompt
  override; the loader-method override achieves the same lazy, reload-visible behavior without
  re-adding a fork-unwanted option to the public services factory, while keeping the
  transformation input the fully composed session system prompt.

### Why an extension could not handle it

- The harness enforces extension-free sessions — it throws when
  `getExtensionPaths().length !== 0` — because comparative evals must not depend on ambient
  extension state. A system-prompt transformation delivered as an extension would break the
  very isolation property the harness asserts, so it must act at the services/resource-loader
  layer before the first prompt step.

### Expected merge conflict zones

- The `createAgentSessionServices` call and the `getSystemPrompt` override block whenever
  upstream reshapes resource-loader options or the pin-era `systemPromptOverride` seam.
- Dependency name/version lines shared with `packages/evals/package.json`.
