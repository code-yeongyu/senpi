# prompt-preset Extension Changes

## Overview
Per-model prompt preset extension. Selects a tuned system prompt based on the active model and exposes it through the dynamic prompt builder.

## Files
- `index.ts` - Extension entry point; resolves a preset on session start and on model switch.
- `presets.ts` - Preset name resolution (model id -> preset name) and prompt builder dispatch.
- `settings.ts` - User-overridable preset selection from `settings.json`.
- `gpt-5.ts` / `gpt-5.2.ts` / `gpt-5.3-codex.ts` / `gpt-5.4.ts` / `gpt-5.5.ts` / `gpt-5.6.ts` - GPT-5.x preset prompt builders.
- `claude-opus-4-{5,6,7}.ts` / `kimi-k2-{6,7}.ts` - Other family presets.
- `file-operations.ts` - Shared codex-style "File operations" tuning block consumed by every GPT-5.x preset.

## Kimi K3 preset (2026-07-17)

### What changed
- `kimi-k3.ts`: new preset for the Kimi K3 family. K3 is distilled from Claude Opus 4.8 and Claude Fable 5 on top of the K2-line, so the tuning blends the three: K2 Thinking-class loop discipline (commit to one path, act directly on mechanical work, deep reasoning only where correctness is at risk — per the K2.6/K2.7 presets), Opus 4.8 traits (scope literalism with explicit scope statement; prefer tool calls over reasoning past a lookup-able fact), and Fable 5 traits (act when you have enough information; recommendation-not-survey; audit progress claims against tool results; no text-only promise endings — do the work; outcome-first final summaries in complete sentences; no context-limit wrap-up).
- `presets.ts`: `hasKimiK3Signal` matches `kimi-k3` boundaries plus the bare `k3` id (the `kimi-coding` provider's catalog id); checked via id or display name, ordered before the K2.7/K2.6 checks. Dispatch case added.
- `settings.ts`: `"kimi-k3"` joins `PromptPresetName` and `VALID_PRESETS`.
- `docs/settings.md`, `AGENTS.md`: preset lists updated.
- `test/suite/prompt-presets-kimi-k3.test.ts`: resolution across kimi-coding/moonshotai/moonshotai-cn/openrouter/vercel-ai-gateway/opencode-go ids (incl. `:thinking` tag and display-name matching), non-routing of K2.x/`kimi-for-coding`/`kimi-latest`/`grok-3`, K2.x/K3 tuning isolation, settings + model-metadata override, catalog sweep.

### Why
- Kimi K3 shipped in the model catalogs (packages/ai) without a preset, so it fell back to the untuned dynamic prompt. Its lineage (K2 base, Opus 4.8 + Fable 5 distillation) means the documented behavioral quirks of all three families apply, and each tuning line addresses a quirk documented in the respective prompting guide.

### Why extension system couldn't handle this differently
- Content-only addition inside this builtin; follows the thin-wrapper preset architecture (tuningSection only).

### Expected merge conflict zones on next upstream sync
- LOW: `kimi-k3.ts` is fork-only; `presets.ts`/`settings.ts` touch shared lists — trivial adjacent-line conflicts if upstream adds presets.

## GPT-5.6 omo-parity refinements (2026-07-16)

### What changed
- `gpt-5.6.ts`: rebound the Verification tiers and Manual QA Gate framing from "diagnostics" to "type check / lint" - senpi exposes no diagnostics/LSP tool, and GPT-5.6 follows prompt contracts literally, so the old wording named a validator that does not exist (category A: wrong info). Reframed the tool-loops paragraph as an inverted default ("Independent tool calls run in the same message - serial is the exception and requires a real dependency") and added the shell no-chaining rule (each independent command is its own bash call; no `;`/`&&` for unrelated steps), both from omo Hephaestus 5.6. Todo discipline gains deliverable-not-verb item naming and a turn-end reconciliation rule (completed/blocked/removed, never left `in_progress`) from the omo-codex Hephaestus variant's Task Tracking. The file-reference rule now bans `【F:...†L...】`-style bracketed citations - a Codex-served-model prior the terminal renders broken.
- NOT ported from omo (re-confirmed): `bg_`/`ses_` ID contracts, delegation tables, Oracle escalation, "user does not see command outputs" (false for senpi's TUI), review-lane SHA idempotence (omo-workflow-specific). **Banked for a future spawn tool:** the GOAL / STOP WHEN / EVIDENCE spawn-label contract plus its anti-Goodhart clause (fill labels with outcomes, never mechanisms; judge a child by returned EVIDENCE against its STOP WHEN, never self-report). When a senpi extension grows a spawn surface, this belongs in that tool's description, not this core preset.
- `prompt-presets-extension.test.ts`: pins "serial is the exception", "reconcile every item", "type check", and the absence of `lsp_diagnostics`.

### Why
- Part-by-part comparison against omo's Hephaestus 5.6 prompts (omo-opencode `gpt-5-6.ts` + omo-codex `gpt-5.6.md`) surfaced post-port additions worth adopting and one senpi-side defect (phantom "diagnostics" validator). Edits follow the prompt-engineering skill: each lands at the source section, net growth is under ~80 tokens against the diagnostics rewording, and duplicated rules were merged rather than appended.

### Why extension system couldn't handle this differently
- Content-only change inside this builtin's existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `gpt-5.6.ts` is fork-only; conflicts only if upstream adds its own GPT-5.6 preset.

## GPT-5.6 binding stop contract (2026-07-14)

### What changed
- `gpt-5.6.ts`: ported the Hephaestus stop-contract hardening that landed in oh-my-opencode after the 2026-07-13 parity rewrite (omo commits 03753d38c, a0a89aa6d, 8482f2c9a on `packages/omo-codex/plugin/components/rules/bundled-rules/hephaestus/gpt-5.6.md`). The Intent Gate routing line now declares a per-turn stop condition ("I'll stop right away when [the exact, observable condition that ends this turn]") and names it BINDING. `## Stop Rules` became `## Stop Goal`: the done-conditions moved from a prose run-on into a bulleted list, stop-time "run verification once more" was replaced with "confirm each item against evidence already captured" (the extra validation loop at stop time was itself a stop-goal violation), and stopping is now explicit - mandatory and immediate, no re-polish, no bonus refactor, every action past the stop goal is a defect.
- NOT ported: the GOAL / STOP WHEN / EVIDENCE spawn-label contract (omo commits 4cdac71d6, 53dc9f0a1). It binds `spawn_agent` messages, and senpi has no subagent tools; per the GPT-5.6 guide, the stop-contract-propagation clause only applies "when the prompt spawns subagents".
- `prompt-presets-extension.test.ts`: the gpt-5.6 resolution test pins `## Stop Goal` (and the absence of `## Stop Rules`), the declared-stop-condition line, `BINDING`, and `STOPPING IS MANDATORY AND IMMEDIATE`.

### Why
- GPT-5.6 persists past the finish line: without an explicit stop contract it keeps validating and re-polishing after the work is done. The GPT-5.6 prompting guide made stop rules mandatory and added the "declared, binding stop condition" as part 4 of the stop contract; Hephaestus adopted it upstream on 2026-07-14, and this port keeps the senpi preset at parity.

### Why extension system couldn't handle this differently
- Content-only change inside this builtin's existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `gpt-5.6.ts` is fork-only; conflicts only if upstream adds its own GPT-5.6 preset.

## GPT-5.6 Hephaestus-parity core rewrite (2026-07-13)

### What changed
- `gpt-5.6.ts`: rewrote the full-core prompt to match the Hephaestus autonomous-deep-worker prompt for GPT-5.6 (oh-my-opencode `packages/omo-opencode/src/agents/hephaestus/gpt-5-6.ts`), adapted to senpi's tool surface. Ported: "Implement, don't propose" autonomy (questions imply action; answer-only requires an explicit signal or an opinion/review ask), blocker self-resolution with a one-narrow-question escape, flawed-plan pushback, status-requests-are-not-stop-signals + post-compaction continuation, shared-workspace concurrency rules (never revert changes you did not make), a Goal section (done = artifact works through its surface, not a green build), the Explore -> Plan -> Implement -> Verify -> Manually QA operating loop, a Manual QA Gate with a per-surface table, Failure Recovery with a three-failed-approaches circuit breaker, Pragmatism & Scope (inline single-use logic, boundaries-only validation, no backcompat shims, default to not adding tests), Code Review Requests ordering, an Output section (phase-change-only updates, conclusion-first final message, file-reference format), and Stop Rules with a done-when-ALL checklist.
- NOT ported (omo-only tool contracts senpi does not have): `bg_`/`ses_` ID contracts, explore/librarian/oracle subagents, `background_output`/`background_cancel`, `update_plan`, skill/category delegation tables, `interactive_bash`. GPT-5.6 follows prompt contracts closely; naming nonexistent tools would misroute. senpi equivalents remain: `todowrite`, the dynamic tool section, and harness-injected task docs.
- Kept every senpi contract and test-pinned phrase: the `I read this as` routing line (now doubles as the commit-to-finish preamble), `## Intent Gate`, "outcome-first", todowrite discipline, "fewest useful tool loops", "Lead with the conclusion", `## Verification` tiers, `### Test Discipline`, `## Hard Limits` (extended with the Hephaestus destructive-git and invented-verification invariants), preserve-first style, and `buildFileOperationsTuning()`.
- Merged duplicate rules while porting: the fix-only-your-failures rule lives in Verification only (Pragmatism keeps the diff-scope angle); the Hephaestus Success Criteria and Stop Rules sections collapsed into one `## Stop Rules`; Preamble folded into the routing line.
- `prompt-presets-extension.test.ts`: the gpt-5.6 resolution test now also pins the parity contracts (`Implement, don't propose`, `## Manual QA Gate`, `## Failure Recovery`, `## Pragmatism & Scope`, `## Stop Rules`, the never-revert rule) and guards against omo-only tool names leaking in (`librarian`, `background_output`, `update_plan`).

### Why
- The 2026-07-10 preset encoded GPT-5.6 wording doctrine but kept a collaborator stance: "Answer, explain, review, diagnose, or plan: inspect and report. Do not implement changes unless the request also asks." The requested behavior is the Hephaestus autonomous deep worker, whose defining contract is the opposite - goals in, working artifacts out, with done gated on manual QA through the artifact's real surface. Hephaestus's own GPT-5.6 prompt is written under the same OpenAI 5.6 doctrine (outcome-first, prioritization over brevity, compact authorization policy), so the port preserves the doctrine while flipping the stance.

### Why extension system couldn't handle this differently
- Content-only change inside this builtin's existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `gpt-5.6.ts` is fork-only; conflicts only if upstream adds its own GPT-5.6 preset.

## GPT-5.6 series preset (2026-07-10)

### What changed
- Added `gpt-5.6.ts`: a full-core preset (via the `corePrompt` override, same shape as `gpt-5.5.ts`) covering the whole GPT-5.6 series — the `gpt-5.6` alias plus `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. One preset for the series: the variants share one OpenAI prompting guide and differ only in price/latency tier.
- `presets.ts`: `extractGpt5Version` matches `gpt-5.6` before `gpt-5.5`; `settings.ts`: `"gpt-5.6"` joins `PromptPresetName`.
- Content per the GPT-5.6 prompting guide, diverging from the 5.5 core where the guide documents behavioral deltas: the intent gate carries a compact three-level authorization policy (report / in-scope change + non-destructive validation / confirm destructive) instead of scattered routing rules; style is prioritization and preserve-first ("lead with the conclusion", "never substitute a shorter artifact") because GPT-5.6 over-compresses under generic brevity wording; tool loops get an explicit stopping condition plus a retrieval-fallback decision rule instead of call budgets.
- `prompt-presets-extension.test.ts`: resolution tests for the series (openai, openai-codex, openrouter ids), a catalog-scan test covering every built-in `gpt-5.6*` model, a 5.5/5.6 distinctness guard, a settings-force test, and a `gpt-5.6` entry in the File-operations guard matrix.

### Why
- GPT-5.6 shipped in the model catalogs (sol/terra/luna) with no matching preset, so it silently fell back through `gpt-5.5` matching only when ids contained "gpt-5.5" — 5.6 ids resolved to no preset at all (senpi-current fallback). The 5.6 guide documents prompting deltas (brevity sensitivity, autonomy policy, stopping conditions) that neither the shared core nor the 5.5 core encodes.

### Why extension system couldn't handle this differently
- Preset selection and prompt content are both owned by this builtin; no core prompt code changed beyond consuming the existing `corePrompt` override.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` version matcher if upstream adds its own gpt-5.6 handling; `gpt-5.6.ts` is a new file.

## Claude Opus 4.5-4.8 tuning rewrite against Anthropic overlay docs (2026-07-02)

### What changed
- Rewrote the `tuningSection` of all four Opus presets (`claude-opus-4-{5,6,7,8}.ts`) from first principles against Anthropic's published Opus 4.7/4.8 prompting guidance.
- Deleted dead weight: "maintain coherent state" (a documented native strength — zero information), "do not re-anchor with reminder paragraphs" (redundant with the shared Style no-announcement rules), "do X then Y, follow that exact sequence" (literal models do this natively), the 4.5 caveat-closer ban (redundant with the shared Style permission-begging ban), and the 4.6 "constrain with 'one sentence'" line (prompt-author guidance misframed as a model instruction).
- Added documented deltas the shared prompt does not carry: tools-over-reasoning extended to 4.7 (the tendency is documented starting at 4.7; previously only 4.8 had it), literalism compensation phrased as evident-intent scope with a mandatory scope statement, the persistent cream/serif/terracotta frontend house-style override (4.7/4.8), post-user-turn reasoning economy (4.8 reasons more after user turns in interactive settings), and one harness fact on every Opus preset: senpi auto-compacts context, so never wrap up early (context-aware 4.5+ models otherwise wind down near the limit; mirrors the Fable 5 preset line).
- Kept the family-signal phrases pinned by `prompt-presets-extension.test.ts` ("ordered steps", "full set rather than the first item", "tool calls over reasoning") so existing coverage still locks preset identity.

### Why
- The old tunings restated behaviors Opus 4.7/4.8 exhibit natively while omitting the behaviors Anthropic documents as needing prompt-level overrides in a coding harness. Every remaining line now either overrides a documented model prior or states a harness fact the model cannot derive.

### Why extension system couldn't handle this differently
- The change lives entirely inside the builtin `prompt-preset` extension's Opus tuning strings; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `claude-opus-4-{5,6,7,8}.ts` tuning template literals if upstream revises its own Opus tuning.

## GPT-5.5 full-core rewrite (2026-07-02)

### What changed
- `gpt-5.5.ts`: replaced the shared-core-plus-`tuningSection` shape with a full core rewrite passed through the new `buildDynamicSystemPrompt` `corePrompt` override. The prompt is restructured per the GPT-5.5 prompting guide: outcome-first framing, decision rules instead of process scaffolding, absolutes reserved for true invariants, roughly half the static tokens of the previous shared-core prompt.
- Kept every senpi contract: the `I read this as [intent] - [plan].` routing line (doubles as the GPT-5.5 preamble), todowrite discipline, root-cause "Dig deeper" rule, verification tiers, shared `buildTestDisciplineSection()` rules, hard limits (commit/test/error invariants), and `buildFileOperationsTuning()`.
- Dropped for GPT-5.5 only: the routing table, request-classification taxonomy, key-triggers block, and the multi-bullet execution-stance/scope-of-freedom style sections (collapsed into short decision rules). Other model families are unchanged.
- `prompt-presets-extension.test.ts`: gpt-5.5 assertions now check the rewritten structure (`## Verification`, `### Test Discipline`, `## Hard Limits` present; `## Policies`, `### Execution Stance`, `### Request Classification` absent).

### Why
- The GPT-5.5 guide is explicit that process-heavy prompt stacks add noise, narrow the search space, and produce mechanical answers on this model family. Appending tuning after the full shared core could not remove that scaffolding.

### Expected merge conflict zones on next upstream sync
- LOW: `gpt-5.5.ts` is fork-only; conflicts only if upstream adds its own GPT-5.5 preset.

## Kimi K2.7 catalog coverage + colon-tag boundary (2026-06-15)

### What changed
- Documented the existing `kimi-k2-7` preset across the stale docs that still listed only `kimi-k2-6`: root `README.md` (builtin map + extension table), `builtin/AGENTS.md` inventory, and this extension's `AGENTS.md` (header, FILES tree, `kimi-k2-7.ts` row).
- Extended the trailing boundary of both Kimi matchers in `presets.ts` (`hasKimiK26Signal`, `hasKimiK27Signal`) from `(?:$|[/@._-])` to `(?:$|[/@._:-])` so colon-tagged ids like `moonshotai/kimi-k2.6:thinking` / `moonshotai/kimi-k2.7:thinking` resolve to the Kimi preset instead of falling back to the default dynamic prompt.
- Added regression coverage in `prompt-presets-extension.test.ts`: explicit `it.each` cases for the real catalog K2.7 "code" family across providers (Cloudflare, Fireworks model + router, Moonshot, OpenRouter, Baseten, plus a `:thinking` colon case), a catalog-wide `getKimiK27CatalogModels()` scan asserting every built-in K2.7 model resolves to `kimi-k2-7`, and a K2.6 `:thinking` regression. Kept the test helper signal regexes in sync with the matcher.

### Why
- The `kimi-k2-7` preset, matcher, and settings value already shipped, but every prose surface still said "Kimi K2.6" only. The catalog (`models.generated.ts`) carries nine K2.7 entries (the `kimi-k2.7-code` / `kimi-k2p7-code` family plus a name-only `kimi-coding/k2p7`); all already resolved, but nothing locked that guarantee.
- `:thinking` is a real upstream tag shape on the K2.x line in the models.dev catalog (`kimi-k2.5:thinking`, `kimi-k2.6:thinking`). The old boundary class excluded `:`, so any such id silently missed the Kimi tuning. No colon-tagged Kimi id is in senpi's bundled catalog yet, so this is a forward-looking robustness fix with zero change to current catalog resolution.

### Why extension system couldn't handle this differently
- All changes live inside the builtin `prompt-preset` extension (matcher + tests) and docs; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` Kimi matcher boundary and the Kimi case tables in `prompt-presets-extension.test.ts` if upstream adds its own Kimi aliases.

## Model-level promptPreset metadata (2026-05-12)

### What changed
- `presets.ts` now reads `model.promptPreset` after the global/project `settings.json` hard override and before model-id auto detection.
- `settings.ts` exports `parsePromptPreset()` so resolver paths use the same valid preset parser.
- Added regression tests covering model-level preset resolution and settings precedence.

### Why
- `models.json` is the right place for per-model routing metadata such as “this provider-specific alias should use the Kimi preset.” The prompt-preset extension owns preset-name interpretation, while the model registry only preserves the string metadata.

### Why extension system couldn't handle this differently
- The extension system is the consumer, but it needs the selected model object to already carry metadata from `models.json`. The companion core change adds that metadata preservation without moving preset-name interpretation into core.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` precedence order and `settings.ts` parser export if upstream adds its own model-level preset routing.

## Kimi K2.6 p6 model-id alias (2026-05-12)

### What changed
- Extended the Kimi K2.6 auto preset matcher so model IDs like `kimi-k2p6-turbo` resolve to the existing `kimi-k2-6` preset, alongside the previous dotted `kimi-k2.6-*` IDs.
- The matcher now checks both model ID and catalog model name, so built-in catalog aliases such as Cloudflare, Fireworks `kimi-k2p6`, Moonshot, OpenRouter, Together, and Vercel Kimi K2.6 entries all resolve to `kimi-k2-6`.
- Added a prompt-preset regression case for `kimi-k2p6-turbo`.
- Added catalog-wide coverage that scans built-in Kimi K2.6/K2p6 models and verifies each one resolves to `kimi-k2-6`.
- Documented the existing `promptPreset` setting in `docs/settings.md` so users can force `kimi-k2-6` through global or project settings when auto-detection is not desired.

### Why
- Some providers encode the K2.6 family with `p6` rather than `.6`. Without this alias, those models fell back to the default senpi dynamic prompt instead of the Kimi-specific tuning.

### Why extension system couldn't handle this differently
- This is implemented inside the builtin `prompt-preset` extension's model-family dispatch; no core prompt code needed to change.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` Kimi matcher and the Kimi case table in `prompt-presets-extension.test.ts` if upstream adds its own Kimi aliases.

## Codex-style File operations tuning (2026-05-07)

### What changed
- Added `file-operations.ts` exposing `buildFileOperationsTuning()` - a single source-of-truth paragraph that anchors `apply_patch`, `read`, and the senpi `grep` tool as canonical verbs and forbids inline python/sed/awk/heredoc-driven file mutation through bash.
- Every GPT-5.x preset (`gpt-5.ts`, `gpt-5.2.ts`, `gpt-5.3-codex.ts`, `gpt-5.4.ts`, `gpt-5.5.ts`) now appends this tuning block to its `tuningSection`.

### Why
- senpi's prior dynamic prompt mentioned `apply_patch` only inside the function-calling schema; the prompt body had no positive routing for it. Combined with the absence of an inline-python guard, this let GPT's "files = python" pre-training prior fire unchecked. Codex's GPT-5.2 prompt (`codex-rs/core/gpt_5_2_prompt.md`) handles the same prior with explicit "Use the apply_patch tool" + "Do not use python scripts to attempt to output larger chunks of a file" lines; we mirror that here.
- The `apply_patch` tool itself already exposes `promptSnippet` + `promptGuidelines` (locked in by tests added this turn), but those only land in the senpi `## Available Tools` / `## Tool Guidelines` sections; the codex-style File operations paragraph reinforces the same guard inside the tuning section so the signal lands twice through different prompt mechanics. Negative-only directives lose to strong priors; we pair positive routing with a negative guard.
- The shared helper keeps the five preset files DRY and prevents drift; a single edit updates every GPT-5.x prompt.
- The "use the `grep` tool, not bash-invoked grep/rg" line addresses the senpi-vs-codex inconsistency: codex recommends the `rg` binary because codex has no first-class `grep` tool, but senpi exposes a ripgrep-backed `grep` tool that should be preferred over either external binary.

### Why extension system couldn't handle this differently
- This *is* the extension system. The change lives entirely inside the `prompt-preset` builtin extension; no upstream source files outside `builtin/` were touched for this part.

### Expected merge conflict zones on next upstream sync
- LOW: `gpt-5{,.2,.3-codex,.4,.5}.ts` `tuningSection` template literals - upstream has no equivalent helper. If upstream adds its own tuning lines, append rather than overwrite the file-operations block.
- LOW: `file-operations.ts` is new and additive; no upstream counterpart.
