# changes.md — dynamic-prompt

## Conditional delegation rule + compaction mechanism in the shared core (2026-09-03)

### What changed

- `working-task.ts`: one sentence appended to the one-plan paragraph - "When a delegation tool is available, hand sizeable independent tracks to subagents and keep working while they run; keep work you can finish in a few calls yourself." Conditional wording, inert without a delegation tool.
- `style.ts`: the context-limits sentence gains its mechanism - "the harness compacts context automatically" - per claude.md's context-awareness guidance (tell the model the harness compacts so it does not wrap up early).
- Rendered fallback (no tools): +39 o200k tokens.

### Why

- Both rules lived only in the full-core presets (fable-5/5.1, gpt-5.6) and as per-preset copies of the compaction line in every Opus 4.x tuning. The 2026-09-03 preset parity audit (`extensions/builtin/prompt-preset/changes.md`) gives each rule one home here so the thin Claude/GLM/Kimi presets and the fallback carry them once, and the per-preset duplicates are deleted.

### Why extension system couldn't handle this

- Core prompt assembly; the fallback text is core-owned.

### Expected merge conflict zones

- `working-task.ts` / `style.ts` wording. Resolution: keep the one-sentence delegation rule and the mechanism clause.

## Universal-fallback diet: dieted core sections aligned with per-model preset lessons (2026-09-02)

### What changed

- `intent-gate.ts`: the routing line now carries a declared observable stop condition ("I'll stop when …"), matching the binding stop contract already proven in the claude-fable-5 / claude-opus-5 / gpt-5.6 / kimi-k3 / grok-4.6 presets — stated calmly, without all-caps emphasis (Kimi guidance: caps directives cause overthinking). The six-row Surface Form table and five-bullet request-classification list are compressed into the three intent-family decision rules the dieted presets converged on (information / judgment / change). Scope-fidelity ("never quietly narrow, widen, or swap") and routine-judgment-call rules moved here from nowhere — they existed only in presets before. `### Turn-Local Intent Reset` and `### Context-Completion Gate` subheadings folded into one closing paragraph.
- `working-task.ts` (new): merges `parallel-tools.ts` + `exploration.ts` into one `## Working the Task` section (both files deleted) and adds the one-plan commitment rule ("make one reasonable plan and execute it; reopen only on contradictory evidence") — the highest-value cross-family convergence point from the K2.6/K3 overthinking guidance that the fallback lacked entirely.
- `verification.ts`: the closing paragraph adopts the claim-audit rule from the fable-5 preset ("audit each claim against a tool result from this session") — replaces the weaker "Reporting clean output without running the validator is a violation" sentence.
- `policies.ts`: `### Anti-Patterns` merged into `### Hard Blocks` — the split duplicated one concern across two headings ("never suppress" vs "do not delete failing tests"); each pair is now one line, matching the presets' `## Hard Limits` shape. The "never speculate" line merged into "never present unread code as verified fact".
- `style.ts`: rules the dieted presets all carry but the fallback lacked: end-of-turn last-paragraph check (promise-about-undone-work means do it now), blocked-part handling (finish independent parts, name the blocker), surgical-edit preference, reader-grounded final summary (complete sentences, outcome first), and context-limit continuation. "Bullets only for genuinely list-shaped content" reframed positively; "match the user's tone, profanity included" dropped the trailing clause (tone-matching already covers it).

### Why

The fallback serves genuinely unknown/new models — every named family routes to a preset. Study of all per-model prompting guides (claude.md, fable-5/5.1, opus-4.7/4.8, gpt-5.2–5.6, kimi.md) plus the five dieted presets showed the fallback carried structures every diet had removed (routing table, classification taxonomy, split subsections, duplicated policies) while missing the behaviors every preset restated (stop condition, one-plan commitment, claim audit, last-paragraph check, blocked-part handling, context continuation). Guides agree on the direction: minimal outcome-first prompts beat process-heavy stacks (GPT-5.6 evals: 10–15% score gain at 41–66% fewer tokens); positive decision rules beat prohibition stacks (Kimi/Claude); tables and label taxonomies are scaffolding that does not route. Net token cost of the rewrite: +6 tokens (1,484 → 1,490 o200k tokens on the rendered default core) for eleven added behaviors and four removed redundancies.

### Why extension system couldn't handle this

Core prompt assembly; presets override it per-model but the fallback text itself is core-owned.

### Expected merge conflict zones

- `build.ts` section list (exploration/parallel-tools imports removed, working-task added). Resolution: keep the merged `working-task.ts` section; re-apply upstream section additions on top.
- `intent-gate.ts` wording. Resolution: keep the three-family decision rules + stop-condition routing line.

## User overrides exposed on `_baseSystemPromptOptions` (2026-08-17)

### What changed

- `agent-session.ts`: `_rebuildSystemPrompt()` now records the loader's user overrides on `_baseSystemPromptOptions` — `customPrompt` (the `--system-prompt` / SDK override) and `appendSystemPrompt` (CLI appends pre-joined with `\n\n`). The field type is widened with those two upstream `BuildSystemPromptOptions` members; `buildDynamicSystemPrompt()` ignores them, so the generated prompt is byte-identical when no overrides exist.
- The options flow into `before_agent_start` / `model_select` events and the `ctx.getSystemPromptOptions()` getter, letting prompt-preset yield to user overrides (see `extensions/builtin/prompt-preset/changes.md`).

### Why

- The 2026-07-18 restoration made the base prompt honor loader overrides, but extensions could not tell an override-carrying base from a generated one, so presets clobbered user prompts — which is why the CLI wiring was disconnected on 2026-07-19. Exposing the facts on the options closes that loop.

### Why extension system couldn't handle this

- Same as the 2026-07-18 entry: base prompt assembly is core-owned; only the core knows whether the base came from a user override.

### Expected merge conflict zones

- `agent-session.ts` `_rebuildSystemPrompt()` tail and the `_baseSystemPromptOptions` declaration. Resolution: keep the two override fields populated alongside whatever upstream adds.

## Test-discipline rules: prose-pinning prohibition + behavior wording (2026-08-03)

### What changed

- `verification.ts`: `prompt-behavior-coverage` rewritten as a prohibition — never pin prose, prompt wording, or doc text with a test; test only machine-consumed values (parsed fields, sentinel tokens, shipped-copy equality); a pure-prose change ships with no new test. `mock-contract-integrity` directive now says "behavior being asserted" instead of "contract being asserted" (id and concern unchanged; ids are not rendered into prompts).
- Prose-pinning assertions removed from the prompt test suites in the same increment; remaining prompt coverage asserts parsed rule data and machine-consumed sentinels only.

### Why

A full session-corpus investigation (2026-08-03) found the old wording normalized prompt-text contract tests across every model: 113 sessions used contract-test vocabulary, and docs-only changes grew prose-pinning tests (e.g. `check-mcp-docs.test.mjs`). The rule now forbids the pattern at the source instead of merely preferring behavior assertions, and the word "contract" stops seeding contract-test naming.

### Why extension system couldn't handle this

The Test Discipline section is core prompt assembly (`buildTestDisciplineSection()`), single-sourced into every preset and the fallback prompt; no extension hook rewrites it.

### Expected merge conflict zones

- `verification.ts` rule directives. Resolution: keep the prohibition/behavior wording; re-apply upstream rule additions on top.

## CLI system-prompt overrides reapplied in `_rebuildSystemPrompt()` (2026-07-18)

### What changed

- `agent-session.ts`: `_rebuildSystemPrompt()` again honors the resource loader's `getSystemPrompt()` / `getAppendSystemPrompt()` (populated from `--system-prompt` / `--append-system-prompt`). A loader system prompt replaces the generated dynamic base; loader appends are joined with `\n\n` and appended to whichever base was chosen. With no CLI overrides the generated prompt is byte-identical to before.
- `test/agent-session-system-prompt.test.ts` (new): pins override-replaces-base and append-joins-base behavior through `createAgentSession`.

### Why

The upstream sync restored `systemPrompt` / `appendSystemPrompt` storage on `DefaultResourceLoader`, but the 2026-04-05 dynamic-prompt fork change had dropped the consumer, silently ignoring both CLI flags.

### Why extension system couldn't handle this

Same as the original builder fork: the base prompt assembly is core-owned; extensions can only modify it per-turn via `before_agent_start`.

### Expected merge conflict zones

- `agent-session.ts` `_rebuildSystemPrompt()` tail. Resolution: keep the loader-override selection and append join; thread any new upstream `buildSystemPrompt` parameters through `_baseSystemPromptOptions` equivalents instead.

## Workstation block + execution-context instruction (2026-07-17)

### What changed

- `workstation.ts` (new): synchronous host-facts collector (`os.platform`/`type`/`release`/`arch`, CPU model with `/proc/cpuinfo` fallback on Linux, core count via `os.availableParallelism()`, Apple-Silicon GPU derivation, TERM_PROGRAM terminal) cached per process, plus `buildWorkstationSection()` rendering a `<workstation>` facts block followed by an execution-context instruction in one of four dialects (`default` max-emphasis, `claude` tagged imperatives, `codex` terse, `kimi` positive constraints). The instruction names the active local executors (`bash`/`eval`) from `selectedTools`.
- `build.ts`: `BuildDynamicSystemPromptOptions.workstationDialect?: WorkstationDialect`; the section is assembled right before the date/cwd footer (applies to `corePrompt` presets too).
- All 15 `prompt-preset` builders pass their family dialect.

### Why extension system couldn't handle this alone

- The workstation facts belong to every prompt (fallback included), and the instruction must sit directly under the facts block for context proximity; a preset-level `tuningSection` lands before context files, far from the footer.

### Expected merge conflict zones

- LOW: `build.ts` footer assembly if upstream reshapes it. Resolution: keep the workstation push before the date/cwd push.

## AGENTS.md precedence contract in Project Context (2026-07-16)

### What changed

- `build.ts`: the `## Project Context` section now opens with one precedence line: project instruction files (inline and `[Directory Context: ...]` blocks injected by nested-agents-md) bind files under their directory, deeper files win on conflict, explicit user instructions override. Ported from omo Hephaestus's `# AGENTS.md` section.
- `build.test.ts` pins "deeper files win on conflict".

### Why

- senpi injects nested AGENTS.md content at read time but stated no precedence rule anywhere, leaving root-vs-nested conflicts as unresolved contradictions - the exact instability the GPT-5.6 guide warns about ("conflicting rules can create more instability than missing detail"). One ~25-token line closes the contradiction channel for every preset.

### Why extension system couldn't handle this

- `buildContextFilesSection` is core-owned and shared by every preset and the fallback prompt.

### Expected merge conflict zones

- LOW: `build.ts` context-section header block.

## Token diet for shared sections (2026-07-02)

### What changed

- `intent-gate.ts`: Key Triggers now render only when search tools exist (the "No specialized trigger tools are available" line was pure noise); the three trigger bullets collapsed into one sentence. The "never speculate about unread code" bullet was deleted from the Context-Completion Gate — it duplicated the Policies hard block verbatim. Turn-Local Intent Reset and Context-Completion Gate compressed from bullet lists to single sentences. Routing table and the five request classes kept (tests pin them); the forced `I read this as [intent] - [plan].` line and the anti-leakage guard kept per the 2026-04-30 and 2026-04-10 entries.
- `parallel-tools.ts`: dropped the hardcoded `grep`/`ls`/`read` tool names — `ls` is not a registered tool and `grep` is absent in the fallback tool set, so the prompt was citing tools the turn may not have. Guidance is now tool-name-agnostic. "loosely relevant" phrasing kept (pinned).
- `exploration.ts`: deleted "Use tools whenever they materially improve correctness" (no behavioral delta — models already use tools; the payload is the re-read rule and the stop conditions, both kept).
- `style.ts`: the nine Execution Stance bullets collapsed to five. "Don't stop at analysis", "Always be in action mode", "No begging for permission", and "No announcement language" were one action-bias rule stated four ways; "Be genuinely helpful" duplicated the opening no-filler paragraph; "Do your homework first" folded into the action bullet. "Guardrails? None..." theater and the "Scope of Freedom" list compressed into a single "Answer anything" directive that keeps the functional non-refusal intent while dropping wording likely to trip provider safety classifiers. Resolved the standing contradiction between "if you see something that needs fixing, fix it" and "Explicit: no extra scope" in favor of scoped action bias.
- `identity.ts`, `verification.ts`, `policies.ts`, `build.ts`: unchanged.

### Why

- The shared sections had accreted three copies of the action-bias rule, two copies of the no-speculation rule, and two copies of the no-filler rule. Duplicate directives dilute attention across every preset and every fallback turn; the touched sections shrink ~32% (1516 -> 1035 approx tokens; full assembled default 2066 -> 1585) with the same behavioral contract.

### Why extension system couldn't handle this

- These are the shared section builders consumed by every preset and the fallback prompt.

### Expected merge conflict zones

- LOW: section files are fork-owned; upstream does not have `dynamic-prompt/`.

## Optional `corePrompt` override (2026-07-02)

### What changed

- `build.ts`: added `corePrompt?: (context: DynamicPromptCoreContext) => string` to `BuildDynamicSystemPromptOptions`. When set, it replaces the default core sections (identity through style) with the override's output; the rendered tool section is passed in via `DynamicPromptCoreContext` so overrides reuse the dynamic tool list. Tuning, context files, skills, date, and cwd assembly are untouched. The default path is byte-identical to before.
- `index.ts`: re-exports `DynamicPromptCoreContext`.

### Why

- The GPT-5.5 prompting guide calls for short, outcome-first prompts instead of process-heavy scaffolding. A `tuningSection` appended after the full shared core cannot deliver that — the scaffolding it needs to remove is already emitted. `corePrompt` gives a preset a first-class way to rewrite the whole core while keeping the dynamic assembly single-sourced.

### Why extension system couldn't handle this

- Same as the original builder fork: this changes what `buildDynamicSystemPrompt` produces, which extensions can only append to, not replace.

### Expected merge conflict zones

- `build.ts` section assembly if upstream reshapes it. Resolution: keep the `corePrompt` branch and the extracted `toolSection`.

## Test discipline rules in verification prompt (2026-05-15)

### What changed

- `verification.ts`: added a structured `TEST_DISCIPLINE_RULES` set and renders it as a dedicated `### Test Discipline` subsection inside `## Verification`.
- Added semantic rule coverage under `test/suite/prompt-verification-discipline.test.ts`, avoiding raw prompt sentence pinning while still checking that the structured rule set is injected.

### Why

- The shared verification prompt did not tell agents how to handle test code specifically. That left room for flaky waits, fixed sleep-based async tests, over-isolated mocks, and prompt tests that merely assert current prompt text.
- The new rules live in `verification.ts` because they define validation quality, not model-family tuning.

### Why extension system couldn't handle this

- This is shared base-prompt behavior for every preset and fallback prompt. Per-extension prompt riders would apply too late or only in specific extension configurations.

### Expected merge conflict zones

- LOW: `verification.ts` if upstream rewrites the V1/V2/V3 verification section.

## Dynamic System Prompt (2026-04-05)

### What changed

- `agent-session.ts`: `_rebuildSystemPrompt()` calls `buildDynamicSystemPrompt()` instead of `buildSystemPrompt()`. References to `loaderSystemPrompt` (SYSTEM.md) and `loaderAppendSystemPrompt` (APPEND_SYSTEM.md) removed.
- `resource-loader.ts`: Removed SYSTEM.md / APPEND_SYSTEM.md discovery, loading, override, and storage. `getSystemPrompt()` returns `undefined`, `getAppendSystemPrompt()` returns `[]`. Interface methods kept for compatibility.
- New directory `dynamic-prompt/` with 7 files:
  - `types.ts` — AvailableTool interface
  - `tool-categorization.ts` — categorizeTools(), getToolsPromptDisplay()
  - `intent-gate.ts` — Phase 0 intent gate with dynamic key triggers
  - `tool-section.ts` — Categorized tool display with snippets and guidelines
  - `policies.ts` — Hard blocks and anti-patterns
  - `build.ts` — buildDynamicSystemPrompt() assembler
  - `index.ts` — re-exports

### Why

- Replace static pi default prompt with dynamic prompt that adapts to registered tools
- Add intent classification gate (Phase 0) to system prompt
- Remove SYSTEM.md / APPEND_SYSTEM.md file-based prompt overrides

### Why extension system couldn't handle this

The base prompt itself (what `_rebuildSystemPrompt` produces) needed replacement. Extensions can only modify it per-turn via `before_agent_start`, not replace the default builder.

### Modified upstream files

- `agent-session.ts` — 1 import changed, ~6 lines removed in `_rebuildSystemPrompt()`
- `resource-loader.ts` — ~77 lines removed (SYSTEM.md/APPEND_SYSTEM.md machinery)

### Expected merge conflict zones

- `agent-session.ts` line ~904: the `buildSystemPrompt()` call. Resolution: keep `buildDynamicSystemPrompt()`, update args if upstream adds new parameters.
- `resource-loader.ts`: `reload()` method near line 450. Resolution: drop any new SYSTEM.md/APPEND_SYSTEM.md code upstream adds.

## Remove LSP/AST Categories + Generalize Hero Line (2026-04-11)

### What changed

- `build.ts`: Hero line changed from coding-specific ("expert coding assistant operating inside pi") to generic ("You are a helpful assistant."). Two supporting coding-context lines removed.
- `types.ts`: `AvailableTool.category` union narrowed from 6 to 4 values (removed `"lsp"` | `"ast"`).
- `tool-categorization.ts`: Removed `lsp_` and `ast_grep` prefix detection in `getToolCategory()`. Removed `lsp_*` and `ast_grep` entries from `getToolsPromptDisplay()`.
- `tool-section.ts`: Removed `"lsp"` and `"ast"` from `CATEGORY_ORDER` and `CATEGORY_LABELS`.
- Tests updated: `build.test.ts`, `tool-categorization.test.ts`, `intent-gate.test.ts`, `tool-section.test.ts` — all lsp/ast-specific test cases removed or converted.

### Why

- System prompt should be domain-agnostic (not coding-specific).
- LSP and AST tool categories are not used in this fork's tool set.

### Why extension system couldn't handle this

These are core type definitions and prompt builder internals, not per-turn modifications.

### Modified upstream files

All changes are within the `dynamic-prompt/` directory which is already a fork modification.

### Expected merge conflict zones

- `types.ts`: If upstream adds the `"lsp" | "ast"` categories. Resolution: keep narrowed union.
- `tool-categorization.ts`, `tool-section.ts`: If upstream references lsp/ast categories. Resolution: drop those references.

## Prompt Leakage Guard (2026-04-10)

### What changed

- `intent-gate.ts`: Replaced "verbalize intent" wording with an internal-only routing step.
- `intent-gate.ts`: Added explicit guardrails to avoid exposing prompt scaffolding such as "Thinking level", "Step 0", or XML tool-call examples in user-facing output.
- `test/dynamic-prompt/intent-gate.test.ts`: Updated coverage to assert the internal-only wording.
- `test/dynamic-prompt/build.test.ts`: Added regression coverage to keep the assembled prompt from reintroducing `I detect ...` scaffolding.

### Why

- Gemini 3.1 Pro preview with MorphXML-style tool calling could echo prompt scaffolding into normal assistant output.
- The prior instruction explicitly asked the model to verbalize its routing decision, which encouraged user-visible leakage of internal planning text.

## Strong Default + Forced Intent Verbalization (2026-04-30)

### What changed

- `intent-gate.ts`: Reversed the 2026-04-10 "internal-only" guard. The intent gate now requires the model to emit a one-line routing line in the format `I read this as [intent] - [plan].` before acting. The guard against narrating prompt scaffolding ("Step 0", "Thinking level", XML examples) is preserved; only the routing line itself is mandated.
- `build.ts`: Replaced the `"You are a helpful assistant."` opener with a senpi identity section. Added five new reusable sections to the assembled prompt: identity, parallel tool calls, exploration discipline, verification rigor (V1/V2/V3 tiers), and style. Added an optional `tuningSection` field for per-model addenda.
- New files in `dynamic-prompt/`: `identity.ts`, `parallel-tools.ts`, `exploration.ts`, `verification.ts`, `style.ts`. Each exports a single `build*Section()` function consumed by `build.ts` and re-exported from `index.ts`.
- `test/dynamic-prompt/intent-gate.test.ts` and `test/dynamic-prompt/build.test.ts`: Updated to assert the verbalization mandate and the new sections.

### Why

- The default fallback prompt was producing weak, generic-LLM-bot output ("You are a helpful assistant." with bare intent gate, tool list, and policies). The README already advertised forced intent verbalization, but the code contradicted it. Strengthening the default reconciles README and code, and gives every model that lacks a preset a strong neutral senpi prompt.
- The 2026-04-10 leakage fix was a Gemini-specific patch applied as a global silencer. The proper place for that patch is a Gemini-specific overlay (or a per-model preset), not the shared default. Revoking it here while preserving the "do not narrate prompt scaffolding" guard restores the verbalization for every other model.
- The bold parallel-tool-calls section ("if a directory or symbol is even loosely relevant to the request, run `grep`, `ls`, and `read` in parallel") was missing entirely. Adding it makes the default suitable for agentic use without falling back to model-specific presets.

### Why extension system couldn't handle this

These are core builder internals and the shared shape of every prompt the agent emits in the absence of a preset. Extensions can only inject before/after a turn; they cannot replace the default builder.

### Modified files (this fork)

All changes are within the existing `dynamic-prompt/` directory.

### Expected merge conflict zones

- `intent-gate.ts`: If upstream re-introduces an "internal only" routing rule. Resolution: keep the verbalization mandate; reapply any additional anti-leakage guard on top of it.
- `build.ts`: If upstream rewrites the assembly. Resolution: keep the senpi identity and the new section calls.

## Preset Files Renamed to Model Families (2026-04-30)

### What changed

- `extensions/builtin/prompt-preset/`: Deleted the three persona-named preset files. Replaced with model-named files: `claude-opus.ts`, `kimi-k2-6.ts`, `gpt-5.ts`. Each new preset is a thin wrapper that calls `buildDynamicSystemPrompt` with a small `tuningSection` carrying only the model-specific notes.
- `presets.ts`: Renamed the `is*Model` helpers to model-family-named functions (`isGpt5FamilyModel`, `isClaudeOpusModel`). Split `resolvePreset` into `resolvePresetName` (cheap, used by the startup header) and `resolvePreset` (builds the full prompt). Settings overrides accept the new model-named values.
- `settings.ts`: `PromptPresetName` is now `"auto" | "claude-opus" | "kimi-k2-6" | "gpt-5"`.
- `index.ts` (extension wiring): Passes the full `BuildDynamicSystemPromptOptions` (including `cwd`, `contextFiles`, `skills`) through to the preset builders so presets reuse the strengthened default.
- All three `test/suite/prompt-presets-*.test.ts` files: Updated assertions to match the new preset names and the senpi-neutral identity.

### Why

- Senpi is a neutral coding agent. Persona-named presets collapsed identity into specific personas and made model selection hard to reason about. Naming presets after the model family they target makes the link from `--model` to active preset obvious.
- The old presets duplicated identity, intent, exploration, and verification language. Each was 100+ lines of mostly-shared content. The new architecture (default carries the shared behavior, preset carries only the model-specific tuning) cuts each preset to ~10 lines and keeps tuning easy to review.

### Why extension system couldn't handle this

Preset selection is wired through a builtin extension that already lives in this directory. The rename touches that extension's settings, selector, and tests as a single unit.

### Modified files (this fork)

All changes are within `extensions/builtin/prompt-preset/` and the matching tests under `test/suite/`.

### Expected merge conflict zones

- `presets.ts`, `settings.ts`: If upstream renames or reshapes the preset settings. Resolution: keep the model-named taxonomy.
