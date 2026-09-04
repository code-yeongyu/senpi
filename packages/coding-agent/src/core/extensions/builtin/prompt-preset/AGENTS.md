# builtin/prompt-preset

Builtin extension #7. On `before_agent_start` and `model_select`, picks a system prompt preset by **model family** (gpt-5.x through gpt-5.6, gpt-6-astra, claude-fable-5, claude-fable-5-1, claude-opus-5, claude-opus-4-{5,6,7,8}, glm-5.2, glm-5.3, deepseek-v4-{flash,flash-0731,pro}, kimi-k2-{6,7}, kimi-k3) and falls back to the senpi dynamic prompt when nothing matches. Renders the active preset name in the startup header. After 2026-04-30, presets are thin wrappers around `buildDynamicSystemPrompt()` carrying only model-specific tuning.

## FILES

```
prompt-preset/
├── index.ts             # Extension entry — hooks before_agent_start + model_select
├── presets.ts           # Model-id matchers + dispatch (resolvePresetName, resolvePreset)
├── settings.ts          # PromptPresetName settings type ("auto" | family ids)
├── file-operations.ts   # Shared "use apply_patch, not python heredoc" tuning block (codex-style)
├── gpt-eval-routing.ts  # GPT-only bridge to eval's model-aware Tool Guidelines
├── execution-tooling.ts # Shared eval-routing stance rule data (`EXECUTION_TOOLING_RULES`, claude + kimi dialects) rendered only when `eval` is selected; wired into every Claude and Kimi preset. The wait-as-subscription stance is NOT here: `monitor` is eval-only, so that line lives in the eval tool description (`senpi-codemode/src/prompt/eval-prompt.ts`), which is the only surface that can teach the `tool.monitor(...)` form
├── gpt-5.ts             # GPT-5 baseline preset
├── gpt-5.2.ts           # GPT-5.2 preset
├── gpt-5.3-codex.ts     # GPT-5.3 Codex preset
├── gpt-5.4.ts           # GPT-5.4 preset
├── gpt-5.5.ts           # GPT-5.5 preset — full-core rewrite via `corePrompt` (outcome-first, per the GPT-5.5 prompting guide)
├── gpt-5.6.ts           # GPT-5.6 series preset (sol/terra/luna) — dieted full-core rewrite via `corePrompt`; Hephaestus-parity autonomous deep worker (implement-don't-propose, Manual QA Gate, binding stop contract: declared per-turn stop condition + Stop Goal) under GPT-5.6 simplify-first doctrine; also owns `GPT56_EXECUTION_RULES` — typed execution-discipline rule data (eval-first code-cell routing, maximum parallel batching, over-call bias, in-kernel reduction, stay-direct exceptions, subagent fan-out, finest-grain todos, test-first, atomic commits, LSP symbol routing) rendered one directive per point of use
├── gpt-6-astra.ts       # GPT-6 Astra preset — full-core rewrite via `corePrompt` written from scratch against the GPT-6 Astra guide: `## Initiative` (bias to action, approval as the last step on a reviewable result, steering, no unsolicited caution), `## Instructions From Files` (user > skills/project files/memories; name and quote the line that makes you pause), `## Asynchronous Work` (background handles + completion notifications, no wait tool, `monitor` for every observable wait), engineer-prose `## Writing` with the guide's slop-phrase ban; owns `GPT6_ASTRA_RULES` typed rule data rendered once each; only the eval-cell and async rules carry bold/caps emphasis
├── claude-fable-5.ts    # Claude Fable 5 preset — dieted full-core rewrite via `corePrompt` (Fable 5 prompting guide; binding stop contract)
├── claude-fable-5-1.ts  # Claude Fable 5.1 preset — fable-5 core plus surgical deltas per the Fable 5.1 prompting guide (scope-is-deliverable, batching, surgical edits, test scope, formatting/narration recalibration); dotted release resolves before the generic fable-5 substring
├── claude-opus-5.ts     # Claude Opus 5 preset — dieted full-core rewrite via `corePrompt` on the fable-5-1 skeleton (one home per rule, Scope section) plus the Opus 5 guide deltas: bounded single-pass verification, delegation caps, narration cadence, correction filter, document length, short conciseness line, outcome-first final summary
├── claude-opus-4-{5,6,7,8}.ts  # Per-snapshot Opus 4.x thin presets: execution-tooling stance + only the guide-documented deltas the shared core lacks (4.7/4.8: literal scope, tool-over-reasoning, same-turn subagent fan-out, house-style counter; 4.8 also reasons over what changed after a user turn; 4.6 carries no tuning text — claude.md documents nothing the dieted core lacks)
├── glm-5.ts             # Shared GLM 5.x builder (`GLM5_TUNING` + `buildGlm5Prompt`): execution-tooling stance in the claude dialect (GLM is Claude-distilled) + a two-sentence tool-over-deliberation / short-loop tuning; 5.2 and 5.3 share one prompting surface (same base model, post-training delta only)
├── glm-5-{2,3}.ts       # GLM 5.2 / 5.3 presets — thin aliases over `buildGlm5Prompt`
├── deepseek-v4.ts       # Shared DeepSeek V4 rule data (`DEEPSEEK_V4_RULES`) + tuning builders (directive authority, todo discipline, missing-info, settled-reading, reasoning-aim)
├── deepseek-v4-flash.ts # DeepSeek V4 Flash preset (thin tuningSection over the shared core)
├── deepseek-v4-flash-0731.ts # DeepSeek V4 Flash 0731 snapshot preset — dated snapshot resolves before the generic flash alias
├── deepseek-v4-pro.ts   # DeepSeek V4 Pro preset (deep-reasoner calibration)
├── kimi-k2-{6,7}.ts     # Kimi K2.6 / K2.7 presets (kimi-k2-6.ts, kimi-k2-7.ts)
├── kimi-k3.ts           # Kimi K3 preset — full-core rewrite via `corePrompt` on the Fable 5.1 skeleton, tuned for Moonshot's documented K3 "excessive proactiveness" (Scope section: request = deliverable, pre-existing problems are follow-ups, test scope; reflect-then-ask ambiguity gate; bounded failure cap; delegation with propagated stop condition) + binding stop contract (declared stop condition in the routing line)
└── changes.md           # Fork tracker (model-family rename 2026-04-30, file-operations 2026-05-07)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Add a preset for a new model release | new `<family>.ts` + entry in `presets.ts` |
| Tune GPT-5.x file-handling guidance | `file-operations.ts` (all GPT presets append it) |
| Tune GPT-5.6 execution discipline (eval/parallel/TDD/commits/LSP) | `gpt-5.6.ts` `GPT56_EXECUTION_RULES` + `test/suite/prompt-presets-gpt-5-6.test.ts` |
| Tune GPT-6 Astra behavior (initiative/instruction precedence/async work/writing) | `gpt-6-astra.ts` `GPT6_ASTRA_RULES` + `test/suite/prompt-presets-gpt-6-astra.test.ts` |
| Tune the eval-default stance for Claude, GLM, and Kimi presets | `execution-tooling.ts` + `test/suite/prompt-presets-execution-tooling.test.ts` |
| Tune the wait-as-subscription (`tool.monitor`) stance | `senpi-codemode/src/prompt/eval-prompt.ts` (eval tool description), not this directory |
| Tune GLM 5.x behavior | `glm-5.ts` `GLM5_TUNING` (both 5.2 and 5.3 render it) |
| Adjust model-id → preset matching | `presets.ts` `resolvePresetName()` |
| User override via settings | `settings.ts` `PromptPresetName` |

## PRESET SHAPE (post 2026-04-30)

```typescript
function buildGpt55Tuning(): string {
   return `…model-specific addenda…

${buildFileOperationsTuning()}`;
}

export function buildGpt55Prompt(options: BuildDynamicSystemPromptOptions): string {
   return buildDynamicSystemPrompt({ ...options, tuningSection: buildGpt55Tuning() });
}
```

Each preset is ~10 lines. The shared default in `dynamic-prompt/` carries identity, intent gate, exploration, parallel-tools, verification, policies, style. Preset only carries **what's different for that model family**.

Exception: `gpt-5.5.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts`, `kimi-k3.ts`, `claude-fable-5.ts`, and `claude-opus-5.ts` pass `corePrompt` instead of `tuningSection` — full core rewrites (the two Claude 5 presets are dieted per the Fable 5 prompting guide — strong instruction following makes the shared scaffolding over-prescriptive — and carry the binding declared-stop-condition contract) (GPT-5.5+ wants short, outcome-first prompts, not the shared scaffolding; GPT-5.6 additionally over-compresses under generic brevity wording, so its style rules are prioritization/preserve-first, and its core is dieted per its own guide's simplify-first doctrine — previously duplicated rules stated once, probe-audited; Kimi K3 uses the Fable 5.1 skeleton with the boundaries Moonshot's K3 release notes call for — K3's documented failure is excessive proactiveness, acting on minor issues and ambiguous intent instead of asking, so the core states scope, ambiguity, and failure-cap rules once each and drops the K2.6-era act-bias repetition that used to outvote them). The 5.6 core is modeled on the oh-my-opencode Hephaestus GPT-5.6 prompt (autonomous deep worker: implement-don't-propose, Manual QA Gate, failure-recovery circuit breaker, stop rules), minus omo-only tool contracts. They still reuse `buildTestDisciplineSection()` (and, GPT-only, `buildFileOperationsTuning()`) plus the builder's dynamic assembly, so shared rules stay single-sourced.

## CONVENTIONS

- **Model-family naming, not personas**: presets are named after the model they target (`gpt-5.ts`, not `coder.ts`). The 2026-04-30 rename removed persona-style names.
- **`file-operations.ts` is appended to EVERY GPT-5.x preset**. New GPT preset → mirror this. Negative-only directives lose to model priors; pair them with positive routing.
- **`resolvePresetName()` is cheap** (used by startup header). `resolvePreset()` builds the full prompt — call only when needed.
- **Don't duplicate identity / intent / exploration** in a preset — they're already in the default builder. The dieted core (2026-09-02/03) also carries one-plan commitment, scope fidelity, the conditional delegation rule, and the auto-compaction continuation fact — a tuning line that restates any of these is dead weight (2026-09-03 audit removed such lines from every Opus 4.x and GLM preset).
- **A tuning line must be documented for the target model**: cite the guide section (or the preset's own probe evidence) in `changes.md`. A preset whose guide documents nothing beyond the core renders execution tooling only (`claude-opus-4-6.ts`).

## ANTI-PATTERNS

- Renaming a preset file to a persona ("coder", "architect", "thinker") — was tried, reverted.
- Embedding full prompt scaffolding in a `tuningSection` — defeats the point of the 2026-04-30 thin-wrapper architecture. A deliberate full rewrite goes through the builder's `corePrompt` override (see `gpt-5.5.ts`), never by duplicating shared sections as tuning text.
- Adding a non-GPT preset that copies `buildFileOperationsTuning()` — the apply_patch routing is GPT-specific.
- Mutating `BuildDynamicSystemPromptOptions` before passing through — pass via spread, add only `tuningSection`.

## NOTES

- Tests under `packages/coding-agent/test/suite/prompt-presets-*.test.ts` validate preset resolution per model-id shape, settings forcing, and catalog coverage; shared tuning text is asserted by shipped-copy equality against the exported constant (`GLM5_TUNING`), never by pinned sentences.
- Prompt-content coverage asserts **parsed rule data**, never pinned sentences (senpi's `prompt-behavior-coverage` test-discipline rule). `prompt-presets-gpt-5-6.test.ts` is the reference shape: ids → concerns, each directive rendered exactly once, and a placement table that fails if a directive drifts out of its owning `## ` section.
- The fork rationale: senpi is a neutral coding agent; persona-named presets collapsed identity into specific personas and made `--model` ↔ active preset hard to reason about. Family naming is the canonical resolution.
- Adding a new model release: copy the closest existing preset, replace the model family in the test, update `presets.ts` matcher, add a regression test.
