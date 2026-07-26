# builtin/prompt-preset

Builtin extension #3. On `before_agent_start` and `model_select`, picks a system prompt preset by **model family** (gpt-5.x through gpt-5.6, claude-fable-5, claude-opus-5, claude-opus-4-{5,6,7,8}, glm-5.2, kimi-k2-{6,7}, kimi-k3) and falls back to the senpi dynamic prompt when nothing matches. Renders the active preset name in the startup header. After 2026-04-30, presets are thin wrappers around `buildDynamicSystemPrompt()` carrying only model-specific tuning.

## FILES

```
prompt-preset/
├── index.ts             # Extension entry — hooks before_agent_start + model_select
├── presets.ts           # Model-id matchers + dispatch (resolvePresetName, resolvePreset)
├── settings.ts          # PromptPresetName settings type ("auto" | family ids)
├── file-operations.ts   # Shared "use apply_patch, not python heredoc" tuning block (codex-style)
├── gpt-eval-routing.ts  # GPT-only bridge to eval's model-aware Tool Guidelines
├── gpt-5.ts             # GPT-5 baseline preset
├── gpt-5.2.ts           # GPT-5.2 preset
├── gpt-5.3-codex.ts     # GPT-5.3 Codex preset
├── gpt-5.4.ts           # GPT-5.4 preset
├── gpt-5.5.ts           # GPT-5.5 preset — full-core rewrite via `corePrompt` (outcome-first, per the GPT-5.5 prompting guide)
├── gpt-5.6.ts           # GPT-5.6 series preset (sol/terra/luna) — dieted full-core rewrite via `corePrompt`; Hephaestus-parity autonomous deep worker (implement-don't-propose, Manual QA Gate, binding stop contract: declared per-turn stop condition + Stop Goal) under GPT-5.6 simplify-first doctrine; also owns `GPT56_EXECUTION_RULES` — typed execution-discipline rule data (eval-first code-cell routing, maximum parallel batching, over-call bias, in-kernel reduction, stay-direct exceptions, subagent fan-out, finest-grain todos, test-first, atomic commits, LSP symbol routing) rendered one directive per point of use
├── claude-fable-5.ts    # Claude Fable 5 preset — dieted full-core rewrite via `corePrompt` (Fable 5 prompting guide; binding stop contract)
├── claude-opus-5.ts     # Claude Opus 5 preset — dieted full-core rewrite via `corePrompt` (Opus 5 prompting-guide behaviors; binding stop contract)
├── claude-opus-4-5.ts   # Claude Opus 4.5 preset
├── claude-opus-4-6.ts   # Claude Opus 4.6 preset
├── claude-opus-4-7.ts   # Claude Opus 4.7 preset
├── claude-opus-4-8.ts   # Claude Opus 4.8 preset
├── glm-5-2.ts           # GLM 5.2 preset
├── kimi-k2-6.ts         # Kimi K2.6 preset
├── kimi-k2-7.ts         # Kimi K2.7 preset
├── kimi-k3.ts           # Kimi K3 preset — full-core rewrite via `corePrompt` (K3 tuning merged into a leaner Kimi-shaped core; K2-family loop discipline + Opus 4.8/Fable 5 distillation traits) + binding stop contract (declared stop condition in the routing line)
└── changes.md           # Fork tracker (model-family rename 2026-04-30, file-operations 2026-05-07)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Add a preset for a new model release | new `<family>.ts` + entry in `presets.ts` |
| Tune GPT-5.x file-handling guidance | `file-operations.ts` (all GPT presets append it) |
| Tune GPT-5.6 execution discipline (eval/parallel/TDD/commits/LSP) | `gpt-5.6.ts` `GPT56_EXECUTION_RULES` + `test/suite/prompt-presets-gpt-5-6.test.ts` |
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

Exception: `gpt-5.5.ts`, `gpt-5.6.ts`, `kimi-k3.ts`, `claude-fable-5.ts`, and `claude-opus-5.ts` pass `corePrompt` instead of `tuningSection` — full core rewrites (the two Claude 5 presets are dieted per the Fable 5 prompting guide — strong instruction following makes the shared scaffolding over-prescriptive — and carry the binding declared-stop-condition contract) (GPT-5.5+ wants short, outcome-first prompts, not the shared scaffolding; GPT-5.6 additionally over-compresses under generic brevity wording, so its style rules are prioritization/preserve-first, and its core is dieted per its own guide's simplify-first doctrine — previously duplicated rules stated once, probe-audited; Kimi K3 gets the shared contracts restated once each in a leaner Kimi-shaped core, because the K2-line guidance says duplicate strictness layered over its RL-tuned instruction following double-taxes into redundant verification loops). The 5.6 core is modeled on the oh-my-opencode Hephaestus GPT-5.6 prompt (autonomous deep worker: implement-don't-propose, Manual QA Gate, failure-recovery circuit breaker, stop rules), minus omo-only tool contracts. They still reuse `buildTestDisciplineSection()` (and, GPT-only, `buildFileOperationsTuning()`) plus the builder's dynamic assembly, so shared rules stay single-sourced.

## CONVENTIONS

- **Model-family naming, not personas**: presets are named after the model they target (`gpt-5.ts`, not `coder.ts`). The 2026-04-30 rename removed persona-style names.
- **`file-operations.ts` is appended to EVERY GPT-5.x preset**. New GPT preset → mirror this. Negative-only directives lose to model priors; pair them with positive routing.
- **`resolvePresetName()` is cheap** (used by startup header). `resolvePreset()` builds the full prompt — call only when needed.
- **Don't duplicate identity / intent / exploration** in a preset — they're already in the default builder.

## ANTI-PATTERNS

- Renaming a preset file to a persona ("coder", "architect", "thinker") — was tried, reverted.
- Embedding full prompt scaffolding in a `tuningSection` — defeats the point of the 2026-04-30 thin-wrapper architecture. A deliberate full rewrite goes through the builder's `corePrompt` override (see `gpt-5.5.ts`), never by duplicating shared sections as tuning text.
- Adding a non-GPT preset that copies `buildFileOperationsTuning()` — the apply_patch routing is GPT-specific.
- Mutating `BuildDynamicSystemPromptOptions` before passing through — pass via spread, add only `tuningSection`.

## NOTES

- Tests under `packages/coding-agent/test/suite/prompt-presets-*.test.ts` validate that each preset produces a non-empty `tuningSection` and contains the model-family signal.
- Prompt-content coverage asserts **parsed rule data**, never pinned sentences (senpi's `prompt-behavior-coverage` test-discipline rule). `prompt-presets-gpt-5-6.test.ts` is the reference shape: ids → concerns, each directive rendered exactly once, and a placement table that fails if a directive drifts out of its owning `## ` section.
- The fork rationale: senpi is a neutral coding agent; persona-named presets collapsed identity into specific personas and made `--model` ↔ active preset hard to reason about. Family naming is the canonical resolution.
- Adding a new model release: copy the closest existing preset, replace the model family in the test, update `presets.ts` matcher, add a regression test.
