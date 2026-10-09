# changes.md — dynamic-prompt

## 2026-10-04 - Format examples are no longer markdown quote lines (senpi#2714)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/handoff.ts`: the handoff template line reads `Ask: [the user's original request] - wanted: ...` instead of `> Ask: ...`.
- `packages/coding-agent/src/core/dynamic-prompt/intent-gate.ts`: the terminal routing line reads `I read this as [intent] - [plan]. ...` instead of `> I read this as ...`.
- Labels, slots and every other sentence are unchanged; each prompt loses two characters per line.

### Why

- The model copies a format example as the shape of its reply, `>` included. A recorded app-surface session on claude-opus-5-5 stored its final messages as `> Ask: ...`, and the desktop drew each whole answer as a grey blockquote that read like a paused turn; the TUI quotes the routing line the same way. Live A/B on the real engine (RPC, app surface, Opus 5.5, same prompts, only the template line changed): before 2 of 3 handoff replies quoted, after 0 of 6. Prompt-engineering category B (misframing): the marker meant "this is the example" and was read as "this is the format", so it is removed at its source; nothing is added.

### Why an extension could not handle it

- These sections are built inside the shared prompt builder; an extension could only append a competing rule.

### Expected merge conflict zones

- Fork-only files. The template line in `buildHandoffSection` and `TERMINAL_ROUTING`.

## 2026-10-04 - A reply that only answers a question is the answer itself, not a handoff block (senpi#2723)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/handoff.ts`: `HANDOFF_MOMENTS` names "the final message of a turn that did work" instead of "the final message", and adds "a reply that only answers a question is the answer itself".
- `packages/coding-agent/src/core/dynamic-prompt/style.ts`: "The final message of work opens with the Handoff block" (was "The final message opens with ...").

### Why

- Every final message had to open with the handoff block, so a one-line answer went into the `For you:` slot of a status block that ended `Now: none. Next: none.` and read as a progress report. The model said so in its own reasoning: "Since the final message needs the handoff block format but the user just wants a single line, I should put that one-line answer in the For you section." The rule is narrowed at its source; the block stays for turns that did work.

### Why an extension could not handle it

- These sections are built inside the shared prompt builder; an extension could only append a competing rule.

### Expected merge conflict zones

- Fork-only files. `HANDOFF_MOMENTS` in `handoff.ts`; the final-message sentence in `style.ts`.

## 2026-10-04 - Handoff: the Fable-only between-handoff sentence names the moment and the shape (senpi#2681)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/handoff.ts`: the `briefUpdatesBetweenHandoffs` branch of `buildHandoffSection` now reads "Between handoffs, after each tool wave that changes what you know, write one line of reply text: what you found, then `Now: [task]. Next: [task].`" (was "Between handoffs, a one-line update on what you just found, ending with `Now: [task]. Next: [task].`, helps the user follow along."). The option's doc comment names its only caller. The default branch ("Between handoffs, work without narration."), the handoff moments, the block template and the language rule are unchanged.
- Only the Claude Fable 5.1 preset passes `briefUpdatesBetweenHandoffs: true`; the default dynamic prompt and every other preset render byte-identical before and after (24-render diff, 0 differences outside `claude-fable-5-1`).

### Why

- The sentence was a recommendation ("helps the user follow along") with no stated moment, and measured sessions showed it produced no more reply text between tool calls than cores that say "work without narration". The Fable 5.1 guide's remedy is a system-prompt line that says when user-facing text is wanted and what each update contains, so the sentence is rewritten at its source rather than reinforced from another section.

### Why an extension could not handle it

- The handoff section is built inside the shared prompt builder; an extension could only append a competing rule.

### Expected merge conflict zones

- Fork-only file. The `betweenRule` ternary and the `HandoffSectionOptions` doc comments in `handoff.ts`.

## 2026-09-30 - Chat surface: no routing line, no handoff block, no ledger lines (senpi#2398)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/types.ts`: `PromptSurface` gains `chat`. New `TerminalOrApp` and `terminalOrApp(surface)`: `chat` takes every `app` entry of a wording table written for the two older surfaces.
- `build.ts`: `resolvePromptSurface` returns `chat` for `SENPI_PROMPT_SURFACE=chat`; anything other than `app` or `chat` is still `terminal`.
- `intent-gate.ts`, `verification.ts`, `style.ts`: `chat` renders the app Intent Gate, the app claim audit (`APP_UNRUN_CHECK_RULE`) and "your stop condition".
- `handoff.ts`: `buildHandoffSection` returns the new `CHAT_REPLIES_SECTION` ("## Replies" + `CHAT_REPLY_RULE`: each reply is a chat message to the people in the conversation, written as the answer itself in their language, with no status block, todo labels or progress ledger). New `CHAT_FINAL_MESSAGE` ("The final message is the answer itself") opens every core's final-message rule on `chat`; `style.ts` uses it in place of "The final message opens with the Handoff block; its For you slot is".
- Terminal and app renders stay byte-identical (180 renders: the dynamic prompt and 29 presets, two input sets, surface omitted / `terminal` / `app`, main vs this branch: 0 differ).

### Why

- A chat bridge posts the final assistant text into a conversation. The terminal prompt asks for a routing line and the app prompt still asks for the Ask / For you / Now / Next block, so both reached the chat room verbatim. The handoff rule is replaced at its source on `chat`; nothing is appended to contradict it.

### Why an extension could not handle it

- The sections are built inside the shared prompt builder; an extension could only append a competing rule.

### Expected merge conflict zones

- Fork-only files. `HANDOFF_MOMENTS` / `buildHandoffSection` in `handoff.ts`; the surface ternaries in `style.ts` and `intent-gate.ts`.

## 2026-09-30 - App surface: an unrun check is covered by the evidence that did run (senpi#2377)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/verification.ts`: `buildVerificationSection({ surface })`. On `app` the claim audit reads "report only evidence-backed work and report failing tests with the output" followed by the new exported `APP_UNRUN_CHECK_RULE`: a check that did not run is covered by the evidence that did run and is named only when no other evidence supports the claim; tool and hook feedback (comment-checker findings, language-server availability, internal notices) is for the agent to act on, reaches the user only when it changes what they get, and an unavailable tool or hook never does by itself. The terminal wording ("flag the unverified explicitly") is unchanged.
- `packages/coding-agent/src/core/dynamic-prompt/intent-gate.ts`: the app Intent Gate no longer carries the tool-feedback sentence; the verification rule is its one home.
- `packages/coding-agent/src/core/dynamic-prompt/build.ts`: passes `surface` to `buildVerificationSection`.
- Terminal renders stay byte-identical (60-prompt render diff against main, 0 differences).

### Why

- A live app-surface run (glm-5.3, shared core plus the GLM5 tuning) ended its reply with "Note: the LSP diagnostics hook is unavailable in this sandbox ...". The Verification section asks for "diagnostics on changed files" and to "flag the unverified explicitly", right where the model writes its report, while the tool-feedback line sat in the Intent Gate. Category A on the app surface: the claim-audit rule itself told the model to name every check that did not run. The rule is rewritten at its source instead of being contradicted from another section, and the feedback guidance moves into it so each prompt states it once.

### Why an extension could not handle it

- The verification section is built inside the shared prompt builder; an extension could only append a competing rule.

### Expected merge conflict zones

- Fork-only files. `CLAIM_AUDIT` and `APP_UNRUN_CHECK_RULE` in `verification.ts`; the `APP_ROUTING` string in `intent-gate.ts`.

## 2026-09-29 - App prompt surface: no routing line, tool feedback stays with the agent (senpi#2377)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/types.ts`: new `PromptSurface = "terminal" | "app"`.
- `packages/coding-agent/src/core/dynamic-prompt/build.ts`: `BuildDynamicSystemPromptOptions.surface?: PromptSurface` (omitted = `terminal`), `DynamicPromptCoreContext.surface` so `corePrompt` overrides render per surface, and `resolvePromptSurface(env)` / `PROMPT_SURFACE_ENV_VAR`: `SENPI_PROMPT_SURFACE=app` selects `app`, anything else (unset included) is `terminal`. The builder threads the surface into `buildIntentGate` and `buildHandoffSection`.
- `packages/coding-agent/src/core/dynamic-prompt/intent-gate.ts`: on `app` the routing-line paragraph is replaced (not overridden) by one that keeps the implementation-commit rule, the observable stop condition (decided before acting, not written out), and the scaffolding guard, and adds one sentence: tool and hook feedback (comment-checker findings, language-server availability, internal notices) is for the agent to act on and reaches the user only when it changes what they get. The intent-family routing rules are unchanged.
- `packages/coding-agent/src/core/dynamic-prompt/handoff.ts`: `HandoffSectionOptions.surface`; on `app` the moment list and the language rule drop their references to the routing line. `HANDOFF_LANGUAGE_RULE` (terminal) is unchanged.
- `packages/coding-agent/src/core/dynamic-prompt/style.ts`: `buildStyleSection({ surface })`; on `app` the context-limit line reads "Continue until your stop condition holds." ("declared" invites the model to write the condition out, which brings the routing line back).
- `packages/coding-agent/src/core/dynamic-prompt/index.ts`: re-exports `PromptSurface`, `resolvePromptSurface`, `PROMPT_SURFACE_ENV_VAR`.
- Terminal renders are byte-identical to the previous builder for the dynamic prompt and every preset (scratch render diff over all 29 preset names x 2 tool sets, empty).

### Why

- Behind an app (the OmO Desktop) every reply opened with the `> I read this as ...` line and relayed internal tool/hook notices; in a chat UI both read as harness chatter. Category C: the builder had no input saying where replies render, so the only option was one prompt for every surface. The app wording removes the mandate instead of appending an override, so no prompt carries both the instruction and its negation.

### Why an extension could not handle it

- The dynamic prompt and the preset cores render the routing line inside their own sections; an extension could only append a second, contradicting rule.

### Expected merge conflict zones

- Fork-only files. The `surface` threading in `buildDynamicSystemPrompt` and the `TERMINAL_ROUTING` / `APP_ROUTING` split in `buildIntentGate`.

## 2026-09-29 - The handoff contract names which parts stay fixed and which follow the user's language (senpi#2366)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/handoff.ts`: new exported `HANDOFF_LANGUAGE_RULE`, rendered in `buildHandoffSection` in place of the sentence `Now and Next are the todo labels verbatim.`, which it absorbs: the labels Ask, wanted, For you, Now, and Next stay exactly as written, and the routing line, slot contents, todo labels, and the reply itself are written in the user's language (the one their instructions name, else the one they write in).

### Why

- Claude cores carry no user-language rule, and the routing line and handoff block are English sentence templates the model copies verbatim, so a user with a "reply in Korean" rule got English todo labels, English `Now`/`Next` slots, and (per the report) English replies. Category C: the model had no way to know which template tokens are machine-parsed (the ttsr repetitive-turns detector reads `Ask:` through `For you:` / `Now:` in model output) and which are fill-in. Every Claude preset renders this section, so one rule covers all of them; GPT-6 Astra keeps its own language line.

### Why an extension could not handle it

- This is the shared handoff section; an extension could only append a second, competing rule.

### Expected merge conflict zones

- The closing sentence of `buildHandoffSection`. Fork-only file.

## 2026-09-25 - The brief-update sentence reads as a sentence (senpi#2143)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/handoff.ts`: the `briefUpdatesBetweenHandoffs` sentence now reads "Between handoffs, a one-line update on what you just found, ending with `Now: [task]. Next: [task].`, helps the user follow along." instead of ending in a stray `.,` with no subject.

### Why

It shipped in the rendered Claude Fable 5.1 prompt as a broken sentence.

### Why an extension could not handle it

This is the shared handoff section.

### Expected merge conflict zones

- `betweenRule` in `buildHandoffSection`.

## Handoff moments: the routing line is not a handoff (2026-09-24, real-surface QA)

### What changed

- `handoff.ts`: `A handoff is the start of a turn, each todo phase change, ...` -> `A handoff is the todo list's creation (in the message that creates it, after the routing line, or the next one), each todo phase change, a blocker or plan change, and the final message; the routing line is not one.` The same moment list is reworded in the three GPT cores (`extensions/builtin/prompt-preset/changes.md`). +9 words in the rendered shared core.

### Why

- A real run on `xai/grok-4.7` against merged main (senpi#2121 QA) opened the turn with the Intent Gate routing line, initialized the todo, and never wrote the handoff block until the final message: the model read "the start of a turn" as already satisfied by the routing line, and the phase-change moments passed with free-form narration. Category B (misframing): the moment was named by position (turn start) instead of by the state the user needs reported (the plan now exists). Naming the first post-todo message and excluding the routing line removes the ambiguity without adding a rule.
- `style.ts`: `The final summary is for a reader who did not watch the work: lead with the outcome ...` -> `The final message opens with the Handoff block; its For you slot is for a reader who did not watch the work: the outcome ...` (+7 words). Second QA finding: on the re-run `claude-fable-5-1` closed with a free-form outcome-first summary and no handoff block, because Style's final-summary sentence and `## Handoff` both governed the final message and the model followed the one it knew best (category B, competing rules). The sentence now says the final message IS the handoff block and its outcome-first shape describes the For you slot, so one rule governs the message.
- `handoff.ts`: option `briefUpdatesBetweenHandoffs` swaps `Between handoffs, work without narration.` for `Between handoffs, one line on what you just found, ending with Now: [task]. Next: [task]., helps the user follow along.` Only `claude-fable-5-1.ts` passes it (`prompt-preset/changes.md`); every other caller keeps the quiet default.

### Why an extension could not handle it

- The sentence is core prompt text; an extension could only append a second, competing definition.

### Expected merge conflict zones

- `handoff.ts` first paragraph and option list; `style.ts` final-summary sentence. Fork-only files.

## Handoff contract replaces the announcement ban; completion bullet (2026-09-24)

### What changed

- `handoff.ts` (new): `buildHandoffSection()` renders `## Handoff` - when a handoff happens (turn start, todo phase change, blocker or plan change, final message) and the one block it carries (Ask / For you / Now / Next, with Now and Next as todo labels verbatim and the Next executed in the same response). `build.ts` places it between policies and style; `index.ts` re-exports it. Option `turnEndRuleStatedElsewhere` drops the "a Next with nothing after it is a defect" clause for a `corePrompt` core that already owns a text-only turn-end rule (the Claude and Kimi K3 cores, see `extensions/builtin/prompt-preset/changes.md`).
- `style.ts`: `Announcement language ("Next, I will...") and permission-begging ("Shall I?") are prohibited.` -> `Permission-begging ("Shall I?") is prohibited.`; `Be concise and concrete: no filler openers, no self-praise, no "it depends" hedging when you have context to judge; plain, literal language;` -> `Plain, literal language; no "it depends" hedging when you have context to judge;`. The `check your last paragraph` sentence and the final-summary sentence stay verbatim.
- `policies.ts` Hard Blocks: `- Never present partial work as complete or deliver a stub, placeholder, or no-op as the feature; say what is done, what is not, and why you stopped.` (short form: `intent-gate.ts` already bans quietly narrowing, widening, or swapping the scope).
- `test/dynamic-prompt/build.test.ts`: `occurrences(prompt, "## Handoff") === 1` on the default render (RED under a duplicated `buildHandoffSection()`).

Rendered default prompt (`buildDynamicSystemPrompt`, empty tool list), `wc -w`: 1174 -> 1309 (+135).

| Delta | Words | Category |
|-------|-------|----------|
| `## Handoff` section (new) | +122 | B+C (the announcement ban framed every progress line as noise; what a handoff carries was missing) |
| Completion bullet in Hard Blocks | +28 | C (nothing said partial or stub work must be named as such) |
| Announcement ban -> permission-begging only | -6 | B (contradicted the handoff) |
| `Be concise and concrete: no filler openers, no self-praise` dropped | -9 | A (generic traits the model already has; a brevity adjective) |

Source files, `wc -w`: `style.ts` 327 -> 312, `policies.ts` 68 -> 96, `handoff.ts` 0 -> 129.

### Why

senpi#2121, the user directive of 2026-09-24: the user must be able to see, at each phase change and at the end, what they asked for, what they need to know, what is running now, and what runs next. The announcement ban plus the absence of any update shape produced silent runs that ended on a plan. Anthropic's guide (`claude.md` "User-facing progress updates") says to describe the shape of updates rather than a cadence counter, so the section names the moments and the block, not a frequency.

### Why an extension could not handle it

The announcement ban lives in the shared core every fallback and thin preset renders; an extension could only append a contradicting rule after it.

### Expected merge conflict zones

- `build.ts` sections array and imports; `style.ts` two sentences; `policies.ts` Hard Blocks tail.

## Date and cwd footer removed from the dynamic prompt (2026-09-24, senpi#2093)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/build.ts`: `buildDynamicSystemPrompt()` no longer appends `Current date:` / `Current working directory:`; the workstation section now closes the prompt. `BuildDynamicSystemPromptOptions.cwd` stays (callers and extensions read it from `_baseSystemPromptOptions`) but is not rendered.

### Why

The footer made the prompt differ per day and per directory, so every prefix cache missed the whole system prompt and everything appended after it. The values now reach the model as an append-only `environment-context` message (`core/environment-context.ts`, see `core/changes.md`).

### Why an extension could not handle it

The footer was emitted by the core assembler every preset calls; an extension can only append after it, not remove it.

### Expected merge conflict zones

- `build.ts` tail after the workstation push, against prompt-section changes.

## claude-sdk-oauth provider id renamed to anthropic-subscription in the dynamic-prompt comment (2026-09-22)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/build.ts`: comment names the `anthropic-subscription` lane that appends dynamic lines after the stable sections.

### Why

Comment accuracy after the provider-id rename; assembly order and content unchanged.

### Why an extension could not handle it

Comment inside the core prompt assembler; nothing to override.

### Expected merge conflict zones

- `build.ts` assembly comment, against prompt-section changes.

## Eval-only grep search guidance (2026-09-14)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/tool-section.ts`: include the shared eval-only grep guideline when grep contributes a snippet but is not selected for direct exposure. The dynamic builder and model presets receive it without adding a new prompt option; withheld grep/bash stay out of Available Tools.

### Why

- `packages/coding-agent/src/core/dynamic-prompt/tool-section.ts`: the selected list intentionally omits eval-only tools, but their callable guidance must survive and direct content search through tool.grep inside eval.

### Why an extension could not handle it

- `packages/coding-agent/src/core/dynamic-prompt/tool-section.ts`: core assembly owns the tool section passed to every prompt preset. An extension-only append would not keep the shared and legacy builders aligned.

### Expected merge conflict zones

- `packages/coding-agent/src/core/dynamic-prompt/tool-section.ts`: the shared guideline import and guideline assembly. Keep selected tool advertisement separate from contributed eval-only guidance.

## Observe edits and perceived results in the shared core (2026-09-09)

### What changed

- `packages/coding-agent/src/core/dynamic-prompt/working-task.ts`: the parallel-wave paragraph adds "Edits and result-dependent calls go one at a time, each compared with the state you meant to produce; when the result must be seen rather than read, render after each change and look before the next." Rendered fallback core: 1600 -> 1632 o200k tokens.

### Why

- The wave rule covered reads only; nothing in the fallback core said that edits are sequential and observed, or that visual results are looked at after each change. Same 2026-09-09 census as the prompt-preset entry (batch-hidden evidence, 24% screenshot rate after frontend edits). Kept to one sentence because the eval-selected presets carry the full rule set.

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
