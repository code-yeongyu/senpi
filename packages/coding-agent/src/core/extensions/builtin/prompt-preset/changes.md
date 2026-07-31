# prompt-preset Extension Changes

## Preset messaging: optimized-prompt wording, silent fallback (2026-07-31)

### What changed

- `index.ts` startup/model-select header now renders `Optimized system prompt applied: <preset>` only when `resolvePresetName()` matches a real preset (including an explicit `promptPreset` settings override); when nothing matches, the header is cleared via `setHeader(undefined)` instead of showing `Prompt preset: fallback (senpi-current)`.
- `index.ts` `model_select` result now returns `systemPromptName: preset?.name` (undefined on fallback) instead of the `"fallback (senpi-current)"` placeholder, so `agent-session._emitModelSelect` emits `system_prompt_change` without a name and the interactive status line stays silent for unmatched models.
- `interactive-mode.ts` switch statuses (`cycleModel`, `selectModelFromUi`) reworded from `system prompt: <name>` to `optimized system prompt applied: <name>`.
- Tests: `prompt-presets-startup-header.test.ts` pins the new wording plus header-clearing on fallback (session_start and model_select paths); `prompt-presets-model-switch.test.ts` now expects `systemPromptName` undefined when switching from a preset model to an unmatched one.

### Why

- User request: the header and switch messages should read as "a system prompt optimized for this model was applied", and models without a matching preset should show nothing at all. The fallback placeholder advertised an implementation detail (the senpi dynamic prompt) as if it were a model preset.

### Why extension system couldn't handle this differently

- The header and `model_select` result already live in this extension; only the two status-line format strings required touching upstream `interactive-mode.ts`.

### Expected merge conflict zones on next upstream sync

- `interactive-mode.ts` `cycleModel` / `selectModelFromUi` status string assembly — two single-line format expressions; re-apply the `optimized system prompt applied:` wording if upstream touches those lines.

## Kimi K3 ambiguity reflect-then-ask gate (2026-07-27)

### What changed

- `kimi-k3.ts` Intent Gate: the trailing scope clause's weak ambiguity rule ("name an ambiguity and resolve it from available context when possible") was replaced by a full decision rule: reread the request once for ambiguity before the routing line; resolve what code, files, and conversation settle; silently fill trivial gaps any senior engineer would fill; when a material ambiguity survives (readings that produce different deliverables, a target the context cannot supply, or conflicting instructions), state the best reading, ask the one specific question that unblocks the work, and end the turn. Building on an invented assumption is classified as a defect, parallel to the existing acting-past-the-stop-condition defect framing.
- `kimi-k3.ts` Style: the permission-begging ban now carves out the Intent Gate's clarifying question ("asking whether to do work the user already requested" stays banned), so the two rules cannot collide.
- `test/suite/prompt-presets-kimi-k3.test.ts`: new structural case asserting section placement (the rule renders inside `## Intent Gate`), the context-first resolution order, the terminal ask condition, the assumption-is-defect classification, single render across the prompt, and the Style carve-out.

### Why

- Moonshot's K3 release notes (surfaced in the community model overview, huggingface.co/blog/ResterChed/kimi-k3-model-overview-mxfp4-quantization-open-wei) document "excessive proactiveness" as a known K3 limitation: in ambiguous scenarios K3 tends to act rather than ask for clarification - a trained MoE prior. The previous clause only said to resolve ambiguity "when possible" with no else-branch, so the trained prior filled the gap: fabricate an assumption and act.
- K2-line prompting guidance says this family terminates loops on explicit conditions and responds to replacement behavior, not prohibitions. The new rule supplies both: a context-first resolution order and a terminal ask condition, phrased positively (no all-caps NEVER, which makes this family overthink).
- Prompt-growth defense: the added sentences replace the weaker clause at the same location rather than appending a trailer; the growth (~65 words) is a category-C prior override - behavior the model cannot derive and actively resists - and nothing else in the core became deletable.

### Why extension system couldn't handle this differently

- The change lives entirely inside the builtin `prompt-preset` extension's K3 core; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- NONE expected: `kimi-k3.ts` and `prompt-presets-kimi-k3.test.ts` are fork-only files with no upstream counterparts.

## GPT-5.6 execution discipline: eval-first parallel orchestration, test-first, atomic commits, LSP routing (2026-07-25)

### What changed

- `gpt-5.6.ts` exports `GPT56_EXECUTION_RULES` — typed rule data (`Gpt56ExecutionRuleId` / `Gpt56ExecutionConcern` / `Gpt56ExecutionRule`), the same shape `dynamic-prompt/verification.ts` uses for the shared test-discipline rules — carrying ten directives across six concerns: `tool-orchestration` (`eval-first-routing`, `parallel-batching`, `over-call-bias`, `in-kernel-reduction`, `stay-direct-exceptions`), `delegation`, `todo-discipline` (`todo-granularity`), `test-first`, `commit-discipline` (`atomic-commits`), `symbol-routing` (`lsp-symbol-routing`).
- Each directive is interpolated exactly once, at its point of use in the existing core, replacing the weaker text it supersedes instead of being appended as a trailer:
  - `Tool loops:` became `Tool orchestration:` — the old "Independent tool calls run in the same message - serial is the exception…" and "Each independent shell command is its own bash call" pair is gone, replaced by the code-cell routing contract (bridge → eval-first → parallel batching → over-call bias → in-kernel reduction → stay-direct exceptions), with a one-sentence fallback for sessions where no code-execution tool is registered. `buildGptEvalRoutingTuning()` moved from a trailing standalone paragraph into this paragraph, so the "which surface" bridge sits next to the "how wide" contract.
  - `stay-direct-exceptions` absorbed the old standalone "empty or suspiciously narrow results" fallback sentence (one rule instead of two overlapping ones), and `over-call-bias` absorbed "when uncertain whether to call a tool, call it".
  - Todo discipline: the mid-paragraph mechanics ("mark items `completed` the moment they finish, and update the list when scope shifts") collapsed into `todo-granularity`, which also adds finest-grain sizing (one item per edit plus the check that proves it) and the never-batch-updates rule.
  - `## Pragmatism & Scope`: **"Default to not adding tests" was deleted** and replaced by `test-first`. This is an intentional policy flip for this preset — the two rules directly contradict each other, and the owner's workflow is TDD. The "never add tests to a codebase with no tests" carve-out went with it.
  - `## Hard Limits`: the commit bullet keeps its permission gate and now also carries `atomic-commits` (per verified increment, repository's existing message convention, each commit green on its own).
  - `lsp-symbol-routing` lands in the "never speculate about code you have not read" paragraph; `delegation` lands on the `Explore -> Plan -> …` line.
  - `lsp-symbol-routing` is deliberately **conditional** ("when LSP tools are available"), which does not reopen the 2026-06 decision to rebind the Verification tiers from "diagnostics" to "type check / lint": senpi's own tool surface still exposes no LSP tool, and the Verification tiers are untouched. Harnesses that do expose `lsp_*` tools get the routing; sessions without them read a condition that is simply false, not a phantom validator.
- `test/suite/prompt-presets-gpt-5-6.test.ts` (new) asserts the rule set as parsed data (ids → concerns, no emoji, minimum directive weight), that every directive renders exactly once and inside its expected `## ` section, that the eval-routing bridge sits in `Working the Task`, that "Default to not adding tests" is gone while `apply_patch` tuning stays, that the dieted core's sections survive, and that neither `gpt-5.5` nor `grok-4.5` inherits any 5.6 directive.
- `test/suite/prompt-presets-extension.test.ts`: the stale `"serial is the exception"` sentence pin was replaced by a loop over `GPT56_EXECUTION_RULES`, so the case asserts rule data instead of a prompt sentence.
- Rendered static prompt: 11,435 → 13,691 chars against this branch's base (+2,256, +19.7%, ~+565 tokens) under the same fixed options. That increase is the deliverable and is defended on its own: ten behaviors the model cannot derive, minus three sentences deleted outright, two overlapping fallback rules merged into one, and cell mechanics the eval tool description already owns trimmed back out.

### Why

- These ten behaviors are category-C context: GPT-5.6 cannot derive from priors that senpi exposes a persistent code kernel (`eval`, or `exec`/`wait`) that can batch a whole step's tool calls, that this fork wants deep-planned maximum-parallel batching and in-kernel reduction, that its workflow is TDD with atomic per-increment commits, or that LSP tools own symbol work. Everything the model already does well stays untouched.
- The GPT-5.6 prompting guide's Programmatic-Tool-Calling section is explicit that generic wording ("use PTC efficiently") does not route: the prompt must name the stage, the eligible surface, the reduction/output expectation, and what stays direct. The rule set is written as that bounded contract, which is also why the emphasis is carried by declarative invariants (EVERY / NEVER / AT ONCE) rather than caps-spam the guide warns degrades 5.6.
- Growth is defended per the entropy gate against this branch's base, not against savings banked by the earlier diet: every added directive replaces or absorbs weaker text, and review feedback bounded the two riskiest ones - the code-cell rule now scopes to steps whose calls can be planned up front (so it no longer contradicts the stay-direct exceptions), and the over-call bias is read-only, with side-effecting or approval-gated calls explicitly barred from riding along.
- Rule data instead of prose keeps the coverage honest: senpi's own test-discipline rule requires prompt tests to assert behavior, decisions, structure, or parsed rule data rather than pinning sentences — and the placement table makes "bolted on at the bottom" a test failure.

### Why extension system couldn't handle this differently

- Everything lives inside the builtin `prompt-preset` extension (`gpt-5.6.ts` plus its tests) and reuses the shared `gpt-eval-routing.ts` / `file-operations.ts` / `buildTestDisciplineSection()` blocks; no core prompt code and no other preset changed. The eval tool's own model-aware batching dialect (`packages/senpi-codemode/src/prompt/eval-prompt.ts`, `codex` style for GPT ids) is deliberately left alone so other GPT presets keep their current wording.

### Expected merge conflict zones on next upstream sync

- LOW: `gpt-5.6.ts` — the file is fork-only; upstream has no counterpart.
- LOW: `prompt-presets-extension.test.ts` gpt-5.6 case block, if upstream edits the same assertions.

## GPT-5.6 dieted full-core rewrite (2026-07-25)

### What changed

- `gpt-5.6.ts`: dieted the full-core prompt in lockstep with the dieted `claude-fable-5.ts`/`claude-opus-5.ts` presets, using the GPT-5.6 prompting guide's own "simplify prompts first" doctrine (trim repeated rules, generic rationale, and examples that do not change behavior; keep outcomes, success criteria, stopping conditions, constraints, tool routing, and output shape). Rendered static prompt shrinks from 12,599 to 11,386 chars (~-304 tokens, -9.6%); the preset-owned core body — excluding the shared test-discipline/eval-routing/file-operations/workstation blocks, which stay byte-identical — shrinks from 10,634 to 9,421 chars (-11.4%). Every behavior preserved, verified by a 115-presence + 13-absence probe audit over rendered before/after prompts (probes derived from the before prompt; the same audit fails 85/128 probes against the gpt-5.5 render, so it discriminates).
- Rules the prompt previously stated more than once are now stated exactly once: the `## Goal` section (goal-not-green-build / spec-satisfied-in-observable-behavior) merged into the Manual QA Gate intro and the first Stop Goal bullet; the final-message reporting shape lives only in `## Output` (the Stop Goal bullet references it instead of restating it); the shared-workspace fact lives only in the concurrency rule; "Never ask permission for obvious work" is subsumed by the authorization policy's opening sentence; `## Code Review Requests` collapsed into one Output rule.
- Enumerated examples trimmed where they carry no routing weight: "how does X work" / "why is A broken" both kept (each names a question-shaped message that still routes to implementation); the "naming, indentation, imports, error handling" style list dropped from the surgical-implementation rule; "never in batches" / "never left `in_progress`" dropped as subsumed by "the moment they finish" and the reconcile-every-item enumeration.
- The complete four-part GPT-5.6 stop contract is intact: binding declared per-turn stop condition in the routing line, per-result stop check in Tool loops, three-attempt failure cap in Failure Recovery, and the Stop Goal with mandatory-immediate stopping. Style remains prioritization/preserve-first — never generic brevity, which GPT-5.6 over-compresses under.
- All test pins kept verbatim ("Implement, don't propose", "## Manual QA Gate", "## Failure Recovery", "## Pragmatism & Scope", "## Stop Goal", "I'll stop right away when", "BINDING", "STOPPING IS MANDATORY AND IMMEDIATE", "serial is the exception", "reconcile every item", "fewest useful tool loops", "Lead with the conclusion", "Never revert or modify changes you did not make", "type check", plus the omo-tool absence guards). No test changes needed.
- `AGENTS.md`: `gpt-5.6.ts` file-table row and the `corePrompt` exception paragraph note the dieted state.

### Why

- Fork direction: diet the system prompts per the prompt-engineering skill. The GPT-5.6 guide itself reports minimal prompts beating process-heavy stacks by ~10-15% in OpenAI's evals at 41-66% fewer total tokens, and duplicated rules compete for attention. The reduction is smaller than the opus-5 diet (-20.0%) because this preset never carried a duplicated shared-core-plus-tuning stack — the savings are pure wording density plus true duplicate merges, with zero dropped behaviors.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin's existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- LOW: `gpt-5.6.ts` is fork-only; conflicts only if upstream adds its own GPT-5.6 preset.


## Claude Opus 5 dieted full-core rewrite (2026-07-24)

### What changed

- `claude-opus-5.ts`: converted from the thin-`tuningSection` shape to a full core rewrite via the `corePrompt` override, by explicit fork direction ("the whole new prompt, not just appending") and in lockstep with the dieted `claude-fable-5.ts`. Static prompt shrinks from 8,564 to 6,852 chars (~-428 tokens, -20.0%) with every behavior preserved — verified by a probe audit over rendered before/after prompts (shared-core probes + 15 Opus-5-specific probes covering the stop contract, observable-end-state goal framing, mandatory-immediate stopping, scope discipline, bounded single-pass verification, no post-stop re-checks, delegation caps, narration cadence, correction filter, document calibration, auto-compaction continuation; negative probes for scope-literalism, house-style counter, GPT/Kimi leakage, and fable-only tuning imports).
- Each Opus 5 guide behavior merged where it binds tightest: stop contract in the intent gate; scope discipline beside intent routing (the "user's call is final" style rule is subsumed by the guide's "say so in a sentence and continue as asked"); bounded verification fused with the shared tier definitions ("run the tier that matches the change once and trust a green result"); delegation caps in Working the Task; narration cadence, correction filter, and document calibration in Style; auto-compaction continuation retargeted at the declared stop condition.
- Deliberately NOT carried (unchanged from the tuning-era preset): 4.7/4.8 scope literalism, the cream/serif/terracotta counter, and any added re-check instructions (the Opus 5 guide says they compound into over-verification).
- Test pins kept verbatim: "You are senpi", "## Intent Gate", "I'll stop when [the exact, observable condition that ends this turn]", "a defect, not diligence", "narrowing, widening, or transforming", "auto-compacts context".
- `AGENTS.md`: `claude-opus-5.ts` joins the `corePrompt` exception list; file-table line updated.

### Why

- Fork direction: Fable 5 and Opus 5 must ship whole rewritten prompts, not the shared core with tuning appended. The tuning-era prompt restated checkpoint/stop/verification rules the shared core already carried; duplicated rules compete for attention. The earlier "not warranted" rationale argued sufficiency of the shared core, not minimality.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin, consuming the existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- `claude-opus-5.ts` whole-file rewrite. Resolution: keep the `corePrompt` full-core shape and re-run the probe audit if upstream reshapes the shared core.

## Claude Fable 5 dieted full-core rewrite + binding stop contract (2026-07-24)

### What changed

- `claude-fable-5.ts`: replaced the shared-core-plus-`tuningSection` shape with a full core rewrite via the `corePrompt` override (the documented full-rewrite path; same shape as `gpt-5.5.ts` / `gpt-5.6.ts` / `grok-4.5.ts`). The static prompt shrinks from 7,765 to 6,608 chars (~-290 tokens, -14.9%; -20.6% like-for-like before the stop-contract addition) with every behavior of the previous prompt preserved — verified by a 55-probe regex audit over the rendered before/after prompts (identity, routing line, anti-leakage guard, all six intent-routing rows, the five scope rules, turn-local reset, context-completion gate, parallel waves, exploration stop rules, verification tiers, all six shared test-discipline rules, claim audit, all hard blocks and anti-patterns, execution stance, style and summary rules, context-limit continuation; negative probes for `apply_patch` and Kimi filler-verification leakage).
- Diet mechanics, per the Fable 5 prompting guide (instruction following is strong enough that one brief instruction steers behavior older models needed an enumerated list for; prompts written for prior models are often too prescriptive and can degrade output): the tuning's duplicated rule families are merged into the core and stated once (act-on-enough-info into Working the Task, claim-audit into Verification, outcome-first summary and context-limit continuation into Style), the 6-row intent table plus 5 scope bullets compress into 3 decision rules carrying the same routing behaviors, and enumerated example lists trim to one defining example per category.
- **Binding stop contract** (explicit fork direction, mirroring `claude-opus-5.ts` / `gpt-5.6.ts`): the routing line gains "I'll stop when [the exact, observable condition that ends this turn]" — an observable end state, not a step count; binding once declared; when it holds: check against already-captured evidence, deliver the final message, stop ("anything past it ... is a defect, not diligence"). The context-limit line is retargeted at it ("Continue the work until your declared stop condition holds"). Fable 5's documented early-stopping and high-effort over-deliberation failure modes are both stop-goal misalignment, so one contract covers both directions.
- Shared pieces stay single-sourced: `buildTestDisciplineSection()`, the rendered tool section via `DynamicPromptCoreContext`, the grep/glob specialized-search line via `getToolsPromptDisplay()`, `workstationDialect: "claude"`.
- All existing test/QA marker phrases kept verbatim ("You are senpi", "## Intent Gate", "I read this as [intent] - [plan].", "a recommendation, not a survey", "audit each claim against a tool result", "on account of context limits").
- `test/suite/prompt-presets-claude-fable-5.test.ts`: added a `TEST_DISCIPLINE_RULES` sweep (the rewrite must never silently drop a shared rule) and a stop-contract assertion.
- `AGENTS.md`: `claude-fable-5.ts` joins the `corePrompt` exception list; file-table line updated.

### Why

- The Fable 5 preset stacked a 1.5K-char tuning on the full shared core, restating Style/Verification rules the core already carried; duplicated rules compete for attention and dilute each other. The Fable 5 prompting guide explicitly calls for removing over-prescriptive prior-model scaffolding. The stop contract follows the same fork direction already adopted for Opus 5 and GPT-5.6: reason about the observable goal, declare when to stop, and stop there.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin, consuming the existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- `claude-fable-5.ts` whole-file rewrite. Resolution: keep the `corePrompt` full-core shape and re-run the probe audit if upstream reshapes the shared core.

## Kimi K3 token diet via `corePrompt` rewrite + binding stop contract (2026-07-24)

### What changed

- `kimi-k3.ts`: switched from shared core + `tuningSection` to a `corePrompt` full-core rewrite (precedent: `gpt-5.5.ts`/`gpt-5.6.ts`). The K3 tuning is merged into a leaner Kimi-shaped core (~19% fewer static prompt chars) with every behavioral contract preserved and stated exactly once: identity/senior-engineer bar, required routing line, anti-leakage guard, dynamic specialized-search trigger line (via `getToolsPromptDisplay`), routing-by-true-intent classifier, scope discipline, turn-local intent reset, confirmation-turn re-entry rule, one-path commitment, mechanical-work direct action, parallel tool waves, exploration stop conditions, no-restate/no-re-derive/filler-verification ban, V1/V2/V3 verification tiers, shared `buildTestDisciplineSection()`, hard blocks, execution stance (act-then-report, recommendation-not-survey, opinionated disagreement, user's call final), smallest-correct-change, non-refusal, ASCII default, auto-compaction continuation. `workstationDialect: "kimi"` unchanged.
- `kimi-k3.ts`: the routing line adopts the **binding stop contract** from the `claude-opus-5.ts`/`gpt-5.6.ts` presets — "I read this as [intent] - [plan]. I'll stop when [the exact, observable condition that ends this turn]." — with the think-through-the-goal requirement (observable end state, not a step count), evidence-only confirmation at the stop point, and "every action past the declared stop condition is a defect, not diligence". Phrased as a positive terminal condition in Opus 5's calm wording rather than GPT-5.6's all-caps Stop Goal, because the K2-line guidance says the trained loop terminates on a condition, not a token count, and all-caps directives make K2/K3-class models overthink. The auto-compaction continuation is retargeted at the declared stop condition.
- `test/suite/prompt-presets-kimi-k3.test.ts`: added the stop-contract pin (mirrors the opus-5 suite).
- `AGENTS.md`: `kimi-k3.ts` FILES row + the `corePrompt` exception paragraph now include K3.

### Why

- The shared core plus appended tuning double-taxed K3: the act-bias rule appeared three times (intent gate, style, tuning) and the no-re-derivation rule twice. Per the Kimi K2-line prompting guidance, K2/K3-class models reason proportionally to the unresolved decisions in their input, and duplicate strictness layered over their RL-tuned instruction following produces redundant verification loops and self-second-guessing — the exact overthinking the 2026-07-17 tuning tightening targeted. A `tuningSection` cannot remove scaffolding the builder already emitted, so the sanctioned `corePrompt` override is the only mechanism that both diets the prompt and keeps the change K3-scoped.
- The stop contract is explicit fork direction (adopted on Opus 5 and GPT-5.6): make the model reason about its actual goal, declare an observable stop condition every turn, and stop there. For K3 it doubles as the strongest documented anti-overthinking lever — an explicit terminal condition for the think-act loop.
- All pre-existing `prompt-presets-kimi-k3.test.ts` content pins hold unchanged ("You are senpi", "## Intent Gate", "running on Kimi K3", "evidence-first", "skip filler verification language", "a recommendation, not a survey", >2000 chars, no `apply_patch`/K2.x tuning leakage).

### Why extension system couldn't handle this differently

- Content-only change inside this builtin, using the builder's existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- LOW: `kimi-k3.ts` is fork-only; `AGENTS.md` prose rows and the K3 test suite only.

## Claude Opus 5 preset (2026-07-24)

### What changed

- `claude-opus-5.ts`: new preset for the Claude Opus 5 family, following the thin-wrapper Claude lineage (`tuningSection` + `workstationDialect: "claude"`, never `corePrompt` — Anthropic's Opus 5 prompting guide states the model performs well out of the box on Opus 4.8 prompts, and 4.8 runs the shared dynamic core). The tuning is built paragraph-per-paragraph from the official guide (platform.claude.com → prompting-claude-opus-5) plus one harness fact:
  - **Binding stop contract** (adapted from the `gpt-5.6.ts` Stop Goal): the routing line gains a declared, observable, per-turn stop condition ("I'll stop when …"), the model must think through the actual goal before naming it, and stopping the moment it holds is mandatory and immediate — "every action past the declared stop condition is a defect, not diligence". This one contract subsumes Opus 5's two documented failure modes, scope expansion and over-verification.
  - **Scope constraint**: the guide's own anti-transformation text (no quiet narrowing/widening/transforming; finish the whole task; stop short of clearly-beyond actions). The 4.7/4.8 scope-literalism paragraph ("every"/"all" mean the full set) is deliberately NOT carried — Opus 5's failure mode inverted from under-scoping to over-scoping.
  - **Bounded verification**: Opus 5 self-verifies unprompted; the tuning binds the shared verification tiers to a single pass and bans post-stop re-checks instead of adding verification instructions (which the guide says compound into over-verification).
  - **Delegation caps**: guide text, phrased conditionally ("when a delegation tool is available") since base senpi exposes no spawn surface; inert without one, binding with one (e.g. omo-senpi task tools).
  - **Narration cadence + late conciseness reminder**: Opus 5 narrates readily and runs longer responses; the guide recommends a short reminder near the end of long prompts — exactly where `tuningSection` lands.
  - **Correction filter and written-deliverable length calibration**: trimmed guide text.
  - **Auto-compaction continuation**: harness fact carried from every prior Claude preset, retargeted at the declared stop condition.
  - NOT carried from 4.7/4.8: the tool-use-over-reasoning nudge (Opus 5 is documented as tool-forward) and the cream/serif/terracotta design counter (undocumented for Opus 5). NOT added: thinking-disabled artifact mitigations (senpi runs Claude with thinking enabled; the guide's primary mitigation is keeping it on).
- `presets.ts`: `isClaudeOpus5Model` (`opus-5` boundary on the normalized id — cannot collide with `opus-4-5`/`opus-4.5`, which contain no `opus-5` substring), checked after the Fable 5 signal and before the 4.x version extraction; dispatch case added.
- `settings.ts`: `"claude-opus-5"` joins `PromptPresetName` and `VALID_PRESETS`.
- `docs/settings.md`, `AGENTS.md`, `builtin/AGENTS.md`: preset lists updated.
- `test/suite/prompt-presets-claude-opus-5.test.ts`: id resolution across bare/provider-prefixed/Bedrock/dated/display-name shapes, non-routing of 4.x/4.5-dotted/fable-5 neighbors (and the reverse), settings force, GPT/Kimi tuning isolation, dropped-lineage pins (no scope-literalism, no house-style counter), and a future-proof catalog sweep (no Opus 5 ids ship in the catalog yet; the sweep guards the day they do).

### Why

- Claude Opus 5 shipped with its own prompting guide; without a preset it fell back to the untuned dynamic prompt and inherited none of the documented behavior counters. The stop-contract emphasis mirrors the gpt-5.6 preset per explicit fork direction: make the model reason deeply about its goal, declare when it will stop, and stop there.

### Why extension system couldn't handle this differently

- Content-only addition inside this builtin; follows the thin-wrapper preset architecture (tuningSection only).

### Expected merge conflict zones on next upstream sync

- LOW: `claude-opus-5.ts` is fork-only; `presets.ts`/`settings.ts` touch shared lists — trivial adjacent-line conflicts if upstream adds presets.

## GPT Code Mode routing for GPT presets (2026-07-22)

### What changed

- `gpt-eval-routing.ts`: exports the GPT-only
  `buildGptEvalRoutingTuning()` rule. Each GPT-5.x builder adds that
  rule, which selects `exec`/`wait` for bounded JavaScript tool
  orchestration when those tools are available, while retaining
  `eval`'s live model-aware guidance as the fallback.
- `test/suite/prompt-presets-gpt-eval-routing.test.ts`: verifies every GPT-5
  preset, including both full-core 5.5/5.6 variants, routes both Code Mode
  surfaces correctly and that Grok does not inherit the GPT-only rule.

### Why

- The persistent eval extension remains the cross-model Code Mode surface and
  model-aware batching guide. GPT presets need a separate high-level route to
  the GPT-only public executor without losing eval as the fallback or leaking
  either policy into Grok through the shared file-operation helper.

### Expected merge conflict zones

- LOW: the GPT preset imports and `gpt-eval-routing.ts` helper if
  upstream adds GPT-specific eval guidance; keep it separate from the
  Grok-shared file-operation block.

## Todo tool prompt naming (2026-07-19)

### What changed

- Updated the GPT-5.5, GPT-5.6, and GLM-5.2 todo-discipline text to call the
  unified `todo` tool instead of the removed `todowrite` tool surface.

### Why

- The builtin extension keeps the historical `todowrite` id for loader
  compatibility, but models now receive one registered tool named `todo`.

### Expected merge conflict zones

- LOW: the three model preset prompt strings and their phrase-pinning tests.

## Grok 4.5 preset (unreleased — 2026-07-17)

Grok 4.5 has **not** been formally merged. Do not invent `v1`/`v2`/… edition labels for unreleased retunes — keep a single current section for this feature until it lands.

### What changed (current branch state)
- `grok-4.5.ts` (2026-07-28, diet): CEO core compressed from 4606 to 3832 template characters (~17% cut) with zero behavior removal, grounded in xAI Grok 4.5 guidance (docs.x.ai/developers/grok-4-5; the grok-code prompt-engineering guide): Grok 4.5 follows terse, structured instructions without repeated emphasis and is trained for tool-loop reliability, so triplicated rules were merged into single homes. Specifically: the audit rules (Role bullet + Operating Loop step 4 + Verification section) collapsed into one **Audit** bullet; the human-surface/report contract (intro + Role bullet + Output) into intro + **Output**; Intent-gate/ask-one-question (Intent Gate + Loop step 1) into **Intent Gate**; plan/todo (Loop step 2) and parallel delegation (Loop step 3) into the **Delegate** bullet; Oracle review (Role bullet + Loop step 5) into the **Consult Oracle** bullet. The `## Operating Loop` and `## Verification` headings are gone; every unique rule they carried survives. All preset-test anchors unchanged and green.
- `grok-4.5.ts`: rewritten as a full-core preset via the `corePrompt` override (same shape as `gpt-5.5.ts` / `gpt-5.6.ts`). The role is now **CEO / orchestrator**, not a sibling tuningSection: Grok 4.5 acts as the single human-facing surface, delegates implementation work to background worker subprocesses spawned via `bash` as `senpi --print -p "..." --model <worker>` invocations (background `&` for parallel, output to temp files, `read` to collect), framed against GPT-5.6 prompting doctrine (implement-don't-propose, Manual QA Gate, binding stop contract). It consults a separate `senpi --print` review invocation before deploying non-trivial changes (the Oracle pattern), audits worker evidence rather than relaying self-report, and reports synthesized outcomes to the user. Trivial one-line fixes stay direct.
- senpi does NOT expose a `task` / `subagent` / `spawn` tool to the model - the built-in tool surface is bash/edit/read/write/grep/ls/find. So the CEO delegates through the concrete primitive it has (`bash` spawning `senpi --print` subprocesses), mirroring the gpt-5.6.ts rule of never naming tools that do not exist here. An earlier draft of this preset referenced a `task` tool with `category: "deep"` / `"ultrabrain"` values; that was a defect (those are the *orchestrator-side* task tool's categories, not anything the senpi agent exposes to Grok), and the regression test now explicitly pins that those names do not appear in the preset.
- Reuses `buildTestDisciplineSection()` and `buildFileOperationsTuning()` so shared rules stay single-sourced. Dynamic pieces (tool section, context files, skills, date, cwd) still come from `buildDynamicSystemPrompt`.
- Prior tuningSection content (act-once-context-sufficient, claim-auditing, no-promise-endings, context-limit continuation) was superseded by the CEO core, which subsumes those rules into the CEO's audit + reporting duties and the binding Stop Goal. The Mario benchmark rationale is preserved below for history.
- Benchmark evidence from the prior tuningSection version is under `local-ignore/qa-evidence/20260717-grok45-mario-benchmark/`.
- `presets.ts`: `hasGrok45Signal` / `isGrok45Model` unchanged (match any Grok 4.5 id shape without catching `grok-4.3` / `grok-4.20-*` / `grok-3`).
- `settings.ts`: `"grok-4.5"` joins `PromptPresetName` / `VALID_PRESETS` (unchanged).
- `test/suite/prompt-presets-grok-4-5.test.ts`: id resolution, negative neighbors, settings force, and catalog coverage unchanged. The old tuning-string regex pins and the 900–1800 character tuning-size guard were replaced with CEO-signal assertions (acting as the CEO and orchestrator; delegate implementation to background workers via `bash`; `senpi --print`; GPT-5.6 prompting doctrine; implement-don't-propose; Manual QA Gate; consult Oracle before deploying; you are the human surface; Stop Goal; STOPPING IS MANDATORY AND IMMEDIATE; `apply_patch` and `### Test Discipline` present; routing-line preserved). Also pins that the preset does NOT name a nonexistent `task`/`category`/`run_in_background` tool.

### Why
- The CEO role is not a small addendum on top of the default identity — it is a different operating posture (orchestrator + human surface, not implementer), which the `tuningSection` shape cannot express. The `corePrompt` override is the documented path for full-role rewrites (per `AGENTS.md` and the gpt-5.5/5.6 precedent). The Mario benchmark established that evidence-grounded continuation and claim-auditing are the right Grok 4.5 execution discipline; the CEO core subsumes those into the CEO's audit + reporting duties and the Stop Goal rather than duplicating them.
- Delegation framing against GPT-5.6 doctrine is chosen because the gpt-5.6 preset already encodes that doctrine for the implementation-worker role; the CEO points its worker children at the same doctrine so worker behavior matches what gpt-5.6 would do in-session.

### Why extension system couldn't handle this differently
- Preset selection and family tuning are owned by this builtin; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `presets.ts` Grok matcher / `settings.ts` union if upstream adds its own Grok preset.
- LOW: `grok-4.5.ts` wording and Grok test phrase pins.

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

## Kimi K3 tuning tightening against overthinking (2026-07-17)

### What changed
- `kimi-k3.ts`: rewrote the `tuningSection` to focus on the K2.6-style loop-discipline signal. Dropped the Opus 4.8 scope-literalism paragraph and the Fable 5 claim-audit / no-promise-ending paragraphs because the shared core already covers verification tiers and the "act, then report" execution stance; restating them in the tuning diluted the anti-overthinking message and added self-reflection loops. The new tuning is shorter, mirrors the proven K2.7 shape, and explicitly adds the K2.6 filler-verification ban.
- `test/suite/prompt-presets-kimi-k3.test.ts`: replaced the `audit each claim` pin with `evidence-first` and `skip filler verification language`; updated the K2.6/K3 isolation assertion from the shared phrase to K2.6's exact opener so the test still guards against accidental preset drift.

### Why
- K3 was overthinking on clear, mechanical, or already-specified work — restating requests, re-deriving established facts, and using filler verification language. The previous tuning tried to prevent this while also carrying scope-literalism and claim-audit instructions; the extra instructions competed for attention and gave the model more opportunities to loop. The K2.6/K2.7 presets solve the same problem with a single, high-signal paragraph.

### Why extension system couldn't handle this differently
- Content-only change inside the existing builtin `tuningSection`; no core prompt code changed.

### Expected merge conflict zones on next upstream sync
- LOW: `kimi-k3.ts` is fork-only; the extension test only touches K3-specific assertions.

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
