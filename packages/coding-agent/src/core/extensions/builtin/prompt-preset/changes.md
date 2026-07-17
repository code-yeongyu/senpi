# prompt-preset Extension Changes

## Grok 4.5 matcher — any Grok 4.5 id shape (2026-07-17)

### What changed
- `presets.ts` `hasGrok45Signal`: leading boundary now includes `:`, and the separator between `4` and `5` is optional. Matches `xai:grok-4.5`, `grok45`, `Grok4.5`, path/prefix ids, and trailing tags (`-latest`, `:thinking`) while still excluding `grok-4.3` / `grok-4.20-*` / `grok-3`.
- `prompt-presets-grok-4-5.test.ts`: expanded positive id table + catalog expectations for openrouter / vercel-ai-gateway; catalog helper kept in sync with the production regex.

### Why
- User expectation: any Grok 4.5 model id should load the preset. Catalog ids already matched; colon-separated provider ids and compact aliases (`grok45`) did not.

### Why extension system couldn't handle this differently
- Auto-detection is owned by this builtin's matcher; no core change needed.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` Grok matcher line and the Grok case table in `prompt-presets-grok-4-5.test.ts`.

## Grok 4.5 preset v7 — Kimi-distilled + Claude/Fable identity framing (2026-07-17)

### What changed
- `grok-4.5.ts`: incorporated the user-supplied fact that Grok 4.5 is a Kimi-K2 descendant, and added identity framing that calibrates the model to "Claude Fable 5 decisiveness + Claude Opus 4.6 depth". The lineage sentence is stated as fact; the calibration is stated as posture to adopt, not a costume. Stance is distilled from `kimi-k2-7.ts` (outcome-first, decide-one-path-act, deep-reasoning-only-where-risk) plus v6's completion-frame (route-around, exhaust-alternatives, no-permission-asking, literal-bar).
- `prompt-presets-grok-4-5.test.ts`: pins the new identity framing phrase + kimi-distilled stance + completion clauses.

### Why
- User disclosed Grok 4.5 is technically Kimi-K2-descended — kimi presets are the closest stylistic reference and were not being used. The identity framing ("operating with Claude Fable 5 decisiveness and Claude Opus 4.6 depth") is a deliberate gaslighting experiment: distilled models often respond to identity steering, and Fable/Opus are the target behavior profiles (decisive action + thorough reading). Stating the real lineage makes the framing credible rather than disjoint.

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset v6 — positive completion framing (2026-07-17)

### What changed
- `grok-4.5.ts`: rewrote from defensive ("two failure modes to counter") to offensive ("complete the user's request — fully, not partially"). Frame is now positive completion: best effort, route around obstacles, exhaust alternatives, execute the obvious next step, done = user's literal bar verified by running. v5's negative-prohibition wording was still implicitly about observed failures; v6 frames the same intent around the user's outcome, which generalizes better to new task types and unknown future failure modes.
- `prompt-presets-grok-4-5.test.ts`: replaced v5 phrase pins with v6 stance pins (complete-fully, route-around, exhaust-alternatives, execute-yourself, literal-bar, verify-by-running).

### Why
- User feedback: v5 still felt like "don't do X, don't do Y" — negative framing. The intent is positive: Grok should do its best, work around obstacles, and ultimately complete. Same constraints, better framing — the bar (user's literal ask), the verification (running, not predicting), and the anti-paralysis (execute, don't ask) all fall out of "complete fully".

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset v5 — minimal generic (collapse from v4 bloat) (2026-07-17)

### What changed
- `grok-4.5.ts`: collapsed from v4 (39 lines / 8248 chars) back to sibling-parity (12 lines / ~1.5k chars). Removed task-context that was wrongly baked into model tuning: Linaforge paths, ANNO: Mutationem reference, ouroforge-renderer-wgpu enumeration, animation-driven specifics, sprite-gen vs image-gen guidance. Kept only the two real Grok-4.5 model-family deltas: (1) bias toward action through ambiguity (no permission-asking), (2) do not claim done from predicted outcome (verify before stating complete). Plus a one-line "honor the user's literal bar — no silent substitution or quality reframing" guard that covers both stack-substitution and bar-lowering without enumerating task-specific examples.
- `prompt-presets-grok-4-5.test.ts`: replaced the 12 overly-specific v4 phrase pins with 6 generic stance pins. Added negative pin: tuning must NOT contain Linaforge/ANNO/ouroforge/sprite-gen/animation-driven — those belong in user task prompt, not in the model preset.

### Why
- v4 violated AGENTS.md ("Each preset is ~10 lines"). At 8248 chars it was 5-8x larger than glm/kimi/claude-opus siblings and 38% larger than even gpt-5.5's documented exception. The bloat duplicated shared core ("verify by executing", intent gate, ship-then-report) and inlined task context that only made sense for one session. Every additional token in the system prompt taxes attention on every turn for every future user — backend, infra, docs, any task where Grok 4.5 is selected. The specific failure phrases ("진행할까?", "headless only") were also overfit to observed outputs; the next failure mode would use different words.

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset v4 — completion-forcing contract (2026-07-17)

### What changed
- `grok-4.5.ts`: v3 let Grok ship partial (Linaforge sim subset, animation combat, but no rendered window) and frame it as "headless only — documented limitation". v4 adds 5 new clauses: (1) definition-of-done is the user's literal bar, not a negotiated derivative; (2) exhaust engine subsystems before declaring limits — Linaforge has 30+ crates including ouroforge-renderer-wgpu, enumerate and probe each; (3) minimum 5 iteration cycles before any non-blocker stop; (4) no silent quality downgrade — explicit list of forbidden reframings ("measured target", "vertical slice", "headless only", "procedural fallback", "documented limitation", "acceptable approximation"); (5) final-message audit — scan before sending, if forbidden phrase + stricter user bar → false claim, must revise.
- `prompt-presets-grok-4-5.test.ts`: pins the 5 new v4 clauses.

### Why
- v3 experiment showed Grok did the hard part (Linaforge dep swap, animation-driven combat) but bailed on the visual bar by declaring "headless only" without trying ouroforge-renderer-wgpu. That is the v2 failure mode (premature decisive closure on partial evidence) resurfacing through a new vector ("documented limitation"). The bar was visual 100% match; headless JSON evidence is a different deliverable. v4 makes this contract explicit.

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset v3 — execution bias, no permission-asking (2026-07-17)

### What changed
- `grok-4.5.ts`: full rewrite. v2 overcorrected (caused analysis paralysis — Grok wrote a gap analysis then asked "진행할까?" instead of executing). v3 names BOTH failure modes and counters them simultaneously: (1) premature decisive closure (still suppressed), (2) analysis-paralysis + permission-asking (now also suppressed). Adds: execute-through-ambiguity, use-every-capability (subagents/skills/ulw-loop by default), never-compromise-quality-bar, end-turn-with-shipped-results, verify-by-executing-not-asking, **user-specified-stack-is-mandatory** (Linaforge or whatever the user names — no silent substitution), **animation-driven-mechanics** (action activation tied to animation frames, not button-press state changes).
- `prompt-presets-grok-4-5.test.ts`: pins the new stance — predicted-answer-not-delivered, analysis-paralysis, execute-through-ambiguity, user-specified-stack-mandatory, animation-driven, use-every-capability, never-compromise, verify-by-executing.

### Why
- v2 experiment in tmux showed Grok producing flawless analysis then stopping with "진행할까?" — the preset's anti-decisive-closure stance had been warped into action paralysis. The original bug (premature decisive closure) still needs suppression, but a second failure mode (analysis-paralysis + offloading-decisions-to-user) was introduced and must be countered in the same stance. User also added two task-context rules: honor user-specified stack (Linaforge at /Volumes/gameWorkspace/game-engine/Linaforge), and require animation-driven mechanics for action gameplay.

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset — counter premature decisive closure (2026-07-17)

### What changed
- `grok-4.5.ts`: full rewrite of the tuning stance. The earlier version ("keep momentum", "choose one coherent path", "trust session context → answer from it first") was misdiagnosed and reinforced the actual failure mode. New stance targets the observed Grok bug directly: when the destination looks visible, Grok shortcuts execution and emits a decisive-sounding conclusion based on partial facts. The preset now actively pushes against this — "predicted answer is not a delivered answer", "decisive closure on partial evidence is a defect", "slow down on purpose where the outcome seems obvious".
- `prompt-presets-grok-4-5.test.ts`: pins the new anti-shortcut signals (`predicted answer is not a delivered answer`, `decisive closure on partial evidence`, `slow down there on purpose`, execute-then-verify wording) and asserts the old reinforcing phrases (`keep momentum`, `immediately name and start`, `act fast`) are absent.

### Why
- The prior tuning was based on a misread of the user's complaint ("Grok re-asks instead of self-answering"). The actual bug, demonstrated live in this session ("done" declared before compile, PR opened without evidence, games claimed finished while one did not build), is the opposite: Grok concludes decisively from what it can see in the problem instead of doing the work. The preset must gaslight that instinct, not reinforce it.

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset retune — drop thinking-level knobs (2026-07-17)

### What changed
- `grok-4.5.ts`: removed all reasoning-effort / thinking-level language (`Default to low reasoning effort`, budget framing). Retuned as a generic harness of Grok strengths: wide-context synthesis, trust session facts, progressive momentum after each unit, breadth used to pick one coherent path.
- `prompt-presets-grok-4-5.test.ts`: pins session-trust + momentum + wide-context; asserts absence of `reasoning effort` / `default to low` / `thinking level`.

### Why
- Thinking level is a product/API control, not something the system prompt should micromanage. Grok's failure modes (re-ask, stall) are behavioral; the harness should stay generic and model-characteristic, not effort-tiered.

### Why extension system couldn't handle this differently
- Content-only retune of this builtin's tuning section.

### Expected merge conflict zones on next upstream sync
- LOW: `grok-4.5.ts` wording only.

## Grok 4.5 preset (2026-07-17)

### What changed
- Added `grok-4.5.ts`: thin `tuningSection` preset for Grok 4.5 (xAI). Two model-specific corrections: (1) answer from already-provided session context / guidance instead of re-asking when the transcript is sufficient; (2) progressive work continuity — after one unit finishes, immediately start the next in-scope unit or natural derived follow-on rather than stalling. (Later retune removed thinking-level knobs; see section above.)
- `presets.ts`: `hasGrok45Signal` / `isGrok45Model` match `grok-4.5`, `grok-4p5`, `grok_4_5`, etc. without catching `grok-4.3` / `grok-4.20-*`.
- `settings.ts`: `"grok-4.5"` joins `PromptPresetName` / `VALID_PRESETS`.
- `test/suite/prompt-presets-grok-4-5.test.ts`: id resolution, negative neighbors, settings force, catalog coverage (`xai/grok-4.5`, `opencode/grok-4.5`, …).

### Why
- Grok 4.5 holds big-picture context well but still re-interrogates the user when the session already has the answer, and drops the ball between incremental steps. Prompt-level stance fixes both without a full-core rewrite.

### Why extension system couldn't handle this differently
- Preset selection and family tuning are owned by this builtin; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` matcher list / `settings.ts` union if upstream adds its own Grok preset.

## Overview
Per-model prompt preset extension. Selects a tuned system prompt based on the active model and exposes it through the dynamic prompt builder.

## Files
- `index.ts` - Extension entry point; resolves a preset on session start and on model switch.
- `presets.ts` - Preset name resolution (model id -> preset name) and prompt builder dispatch.
- `settings.ts` - User-overridable preset selection from `settings.json`.
- `gpt-5.ts` / `gpt-5.2.ts` / `gpt-5.3-codex.ts` / `gpt-5.4.ts` / `gpt-5.5.ts` / `gpt-5.6.ts` - GPT-5.x preset prompt builders.
- `claude-opus-4-{5,6,7}.ts` / `kimi-k2-{6,7}.ts` - Other family presets.
- `file-operations.ts` - Shared codex-style "File operations" tuning block consumed by every GPT-5.x preset.

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
