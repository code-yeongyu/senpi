# prompt-preset Extension Changes

## 2026-10-04 - Routing and handoff format examples are no longer markdown quote lines (senpi#2714)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-fable-5-1.ts`, `claude-fable-5.ts`, `claude-opus-5-5.ts`, `claude-opus-5.ts`, `claude-sonnet-5-5.ts`, `gpt-5.5.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts`, `grok-4.5.ts`, `grok-4.6.ts`, `grok-4.7.ts`, `kimi-k3.ts`: the routing line reads `I read this as ...` instead of `> I read this as ...`; in `gpt-5.5.ts`, `gpt-5.6.ts` and `gpt-6-astra.ts` the handoff template reads `[Outcome so far] toward ...` instead of `> [Outcome so far] toward ...`. Nothing else changes.
- `test/suite/prompt-presets-app-surface.test.ts`: for every prompt (the dynamic prompt and every preset) on the terminal, app and chat surfaces, the assembled prompt has no line that starts with `>`. RED on main: 30 of 30 prompts. `regressions/2366-handoff-user-language.test.ts` keeps checking the label order the ttsr detector parses, without pinning where the line starts.

### Why

- Same cause as `dynamic-prompt/changes.md` (senpi#2714): the model copies the quote marker into its reply, which renders the answer as a blockquote.

### Why an extension could not handle it

- These lines are the preset cores themselves.

### Expected merge conflict zones

- Fork-only files. The routing line and the `## Handoff` template line in each preset.

## 2026-10-04 - Final-message rules leave a plain answer as the answer itself (senpi#2723)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-surface.ts`: `GPT_HANDOFF_MOMENTS` names "the final message of a turn that did work (a reply that only answers a question is the answer itself)"; `gpt-6-astra.ts` carries the same words in `HANDOFF_REPORT` (its app variant is derived by replacing the terminal moments).
- Final-message rules now apply to work: `claude-opus-5-5.ts`, `claude-opus-5.ts`, `claude-sonnet-5-5.ts` ("open with the Handoff block if the turn did work"); `claude-fable-5.ts`, `claude-fable-5-1.ts`, `kimi-k3.ts`, `gpt-5.5.ts` ("The final message of work ..."); `gpt-5.6.ts`, `grok-4.5.ts` ("for work, the Handoff block ..."); `gpt-6-astra.ts` `FINAL_MESSAGE_SHAPE` and its chat replacement ("The final message of work is the handoff block ...").

### Why

- Same cause as `dynamic-prompt/changes.md` (senpi#2723): the block was mandatory for every final message, so plain answers were wrapped in a status block.

### Why an extension could not handle it

- These lines are the preset cores themselves.

### Expected merge conflict zones

- Fork-only files. The final-message sentence and the handoff moments in each preset.

## 2026-10-04 - Claude Fable 5.1: the between-handoff update becomes an instruction; three twice-stated rules go back to one home (senpi#2681)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-fable-5-1.ts`: three sentences are deleted at their source, none added. `## Style` no longer opens with "Act, then report: for reversible steps the request already covers, proceed without asking" (Scope's "Make routine judgment calls yourself; ask only when ..." is the one home); `## Verification` drops `"Should pass" is not verification: run the validator.` and keeps the claim audit ("audit each claim against a tool result from this session; report only evidence-backed work ..."); the fourth `## Hard Limits` bullet drops "; say what is done, what is not, and why you stopped" (Scope's "finish every other part and say exactly what you left out and why" is the one home).
- The between-handoff sentence this preset renders through `buildHandoffSection({ briefUpdatesBetweenHandoffs: true })` is replaced in `dynamic-prompt/handoff.ts` (see that tracker): an instruction naming the moment and the shape instead of a recommendation.
- Render diff against `main` (24 renders: the dynamic prompt and seven presets on terminal, app and chat): only the three `claude-fable-5-1` renders differ; the terminal core goes from 1,550 to 1,522 words.

### Why

- Over two weeks of real sessions Fable 5.1 wrote reply text on 14% of its tool-using steps, the same rate as cores whose handoff section says "work without narration", so the advisory sentence had no measurable effect (prompt-engineering category B: a reason in place of an instruction, with no stated moment). The Fable 5.1 guide says to state when user-facing text is wanted and what each update contains. The three duplicates were left by the 2026-09-02 diet; a rule stated twice competes with itself for a literal instruction follower.

### Why an extension could not handle it

- These sentences are the preset core itself.

### Expected merge conflict zones

- Fork-only file. `claude-fable-5-1.ts` header comment, `## Verification`, `## Hard Limits`, `## Style`.

## 2026-10-03 - GPT-6 Astra: keep few-call reading and own-change checks; a subagent only for a track that lands the task sooner (senpi#2630)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts`: three rules are replaced at their source, none added. `DELEGATION` keeps reading, lookups and checks on your own change "however many calls they take" (was: "whatever closes in a handful of calls is yours"), and hands out only "a track that runs beside yours and lands the task sooner - a wide investigation across many files, or an implementation unit beyond one coherent edit in files you are not touching" (was: "Only a sizeable track independent of your own earns a subagent"); the brief clause shrinks to its four nouns. `ASYNC_DEFAULT` drops "CHILD TASKS AND" from its bold lead. `FOREGROUND_EXCEPTION` ends "A child task never meets the first test; it runs in the background and its completion delivers its result." (was: "... when its result would be your next input, either the work was small enough to do yourself or the child runs in the background and its completion delivers it").
- Rule ids, concerns, sections and the bold set are unchanged; `test/suite/prompt-presets-gpt-6-astra.test.ts` passes as is. The preset loses four words net.

### Why

- Astra handed few-call reading, credential lookups and the checks on its own change to subagents on executable lanes, then ended its turn to wait for them. A 10-day session survey put its delegation share level with the Claude and Kimi presets (the 2026-09-08 reframe did its job by count), but 86% of its spawns went to executable categories against 30-50% for the others, nine were read-only investigations, and in the trigger session the main thread idled 90 s for a child whose evidence memory already held. The model's stated reasons repeated the rule's words ("independent", "non-overlapping"), so the defect is the rule's framing (prompt-engineering category B): a six-call investigation failed the call-count keep-it test and passed the independence spawn test, the loudest rule in the file named child tasks first, and the foreground exception sanctioned the result-needed-next -> background child -> turn-end path. The replacement carries the clauses the Opus 5.5 preset already had (a parallel run must finish the task sooner; your own verification is yours) in the hephaestus prompts' terms (direct execution by default; a category only for a unit beyond one coherent edit). The 2026-09-11 early-stop set is untouched.

### Why an extension could not handle it

- These sentences are the preset core itself.

### Expected merge conflict zones

- `gpt-6-astra.ts` header comment, `DELEGATION`, `ASYNC_DEFAULT`, `FOREGROUND_EXCEPTION`.

## 2026-10-01 - GPT-6 Astra: delete the verification gates codex does not carry (senpi#2505)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts`: nine rules are reduced or removed at their source, none added. The `evidence-comparison` rule is deleted (rule id, table row, render): its surviving sentence was byte-identical to GPT-5.6's and the eval tool description already says to keep every failed item and re-read truncated output before deciding. `TODO_GRANULARITY` drops "an edit paired with the check that proves it" and says a question carries no list. `MONITOR_CONDITIONS` drops "A run, check, PR, or deploy the user mentions is in scope even when the ask is about something else - it gets its watch in the same turn, without being asked". `VERIFICATION_ONCE` is now the whole `## Verification` paragraph: run the checks the change calls for and the ones the repository requires, once; broaden or repeat only on a new change, a failure, or an open concern. The enumerated tier floor ("keep the rigor ... diagnostics on that file ... related tests and one run ... the build and the user-visible behavior exercised through its real surface") is deleted. `BUN_RUNTIME` drops "read it before your first js cell". `FINAL_MESSAGE_SHAPE` (and its app/chat variants) says "the checks that ran, summarized rather than listed, anything left unverified" instead of "what you verified and how, what you could not verify and why". Working the Task opens with "Read a file before claiming what it contains" instead of "Memory of file contents is unreliable: read before claiming, re-read before editing". The hard limit "Never present unread code, unrun commands, or a pending result as fact" is "Label unread code, unrun commands, and pending results as such". The Stop Goal drops "confirm each item and your declared stop condition against evidence already captured" and says "the checks it called for" instead of "the checks for the change's tier".
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/test-decision.ts`: `TEST_DECISION` (shared with GPT-5.6 and GPT-6.1 Sol) drops the two openers "Read existing tests first - the behavior of record" and "Reproduce a bug before fixing it"; the stale-test, wrong-test and add-a-test-only-where clauses are unchanged.
- Concerns, sections and the bold set are unchanged; `test/suite/prompt-presets-gpt-6-astra.test.ts` drops the `evidence-comparison` row from its rule tables; `test/suite/prompt-presets-app-surface.test.ts` keeps passing because the app slot is still spliced through `GPT_APP_UNVERIFIED_SLOT`.

### Why

- Astra prepared and verified instead of acting: 230 s of pre-flight before the first call that touched a yes/no status question and 226 s of wrap-up after the answer was known; `lsp_diagnostics` on a JSON config and upstream tests requested from a child before a config deploy. OpenAI's Astra guide names the prior ("tends to be thorough in testing before considering a task complete ... broader tests than the task requires"), and codex's own Astra template carries two calibration sentences and no gates. Each deleted gate was written against an earlier model's false-claim failure, which Astra does not have (prompt-engineering category A), so it is removed rather than countered. Rendered Astra terminal prompt: measured o200k token delta in the PR.
- Same follow-up line as #2256: the 2026-09-11 early-stop set (`turn-end-is-wait` condition, `unbounded-retry`, `approval-last`, the handoff block) is untouched.

### Why an extension could not handle it

- These sentences are the preset core itself.

### Expected merge conflict zones

- `gpt-6-astra.ts` rule constants, `## Verification`, `## Hard Limits`, `## Stop Goal`, `SURFACE_DIRECTIVE`; `test-decision.ts`.

## 2026-09-30 - Chat surface for every core (senpi#2398)

### What changed

- Every `INTENT_GATE_LEAD` table (Claude Fable 5 / 5.1, Opus 5 / 5.5, Sonnet 5.5, Grok 4.5 / 4.6 / 4.7, Kimi K3, GPT-5.5 / 5.6 / 6 Astra) is keyed by `TerminalOrApp` and looked up through `terminalOrApp(context.surface)`, and every `context.surface === "app"` branch reads `!== "terminal"`, so `chat` gets the app wording. `kimi-k2-6.ts` / `kimi-k2-code.ts`: the "routing line is required every turn" sentence renders only on `terminal`.
- Final-message rules on `chat` say the final message is the answer itself instead of opening with the Handoff block: Claude cores and Kimi K3 through `CHAT_FINAL_MESSAGE`, Opus 5 / 5.5 and Sonnet 5.5 as "When you finish, your reply is the answer itself:", Grok 4.5 as "the final message is the answer itself, leading with the outcome", GPT-5.5 / 5.6 without the You need slot.
- `gpt-5.5.ts`, `gpt-5.6.ts`: the inline `## Handoff` section is `CHAT_REPLIES_SECTION` on `chat`. `gpt-6-astra.ts`: `SURFACE_DIRECTIVE` gains a `chat` entry (app steering, `CHAT_REPLY_RULE` in place of the handoff paragraph, the final-message shape without the handoff block). `gpt-surface.ts`: `GPT_HANDOFF_MOMENTS` is keyed by `TerminalOrApp`.
- `test/suite/prompt-presets-app-surface.test.ts`: the app assertions run for `app` and `chat`; for every prompt, `chat` carries no `> Ask:`, `For you`, `Now: [`, `You need` or "handoff block" while `app` still carries a handoff slot; `resolvePromptSurface` accepts `chat`; a harness session with `SENPI_PROMPT_SURFACE=chat` renders the chat prompt. RED on main: 96 of 337 tests in the targeted files failed.

### Why

- See `dynamic-prompt/changes.md` (2026-09-30, senpi#2398).

### Why an extension could not handle it

- These are the preset cores themselves.

### Expected merge conflict zones

- The `INTENT_GATE_LEAD` tables and final-message sentences in each core; `SURFACE_DIRECTIVE` in `gpt-6-astra.ts`.

## 2026-09-30 - App surface: every core's claim audit covers an unrun check with the evidence that did run (senpi#2377)

### What changed

- `claude-fable-5.ts`, `claude-fable-5-1.ts`, `claude-opus-5.ts`, `claude-opus-5-5.ts`, `claude-sonnet-5-5.ts`, `kimi-k3.ts`: on `app` the core's own claim audit drops "flag the unverified explicitly" and renders `APP_UNRUN_CHECK_RULE` (from `dynamic-prompt/verification.ts`) in its place; the Intent Gate's tool-feedback sentence is removed. Sonnet 5.5 keeps "If no real check can run here, say which one you did not run": with no evidence at all, naming it is what the rule asks for.
- `grok-4.5.ts`, `grok-4.6.ts`, `grok-4.7.ts`: `APP_UNRUN_CHECK_RULE` follows the verification paragraph on `app`; Grok 4.5's final-message slot "what you could not verify and why" reads "anything left unverified that no other evidence covers"; the Intent Gate feedback sentence is removed.
- `gpt-5.5.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts`: "if validation cannot run, say so and name the next best check" / "Say plainly what you could not run and why" become `GPT_APP_UNRUN_CHECK_RULE` on `app`; the final-message slot ("what you could not and why" / "what you could not verify and why") becomes `GPT_APP_UNVERIFIED_SLOT`. Astra keeps `GPT6_ASTRA_RULES` as the terminal wording and derives `finalMessageShape` in `SURFACE_DIRECTIVE`. `gpt-surface.ts`: `GPT_APP_FEEDBACK` is replaced by `GPT_APP_UNRUN_CHECK_RULE` and `GPT_APP_UNVERIFIED_SLOT`.
- `test/suite/prompt-presets-app-surface.test.ts`: for the dynamic prompt and every preset name, the app prompt contains none of "flag the unverified explicitly", "could not verify/run", "cannot run, say so", "what you could not and why"; contains "covered by the evidence that did run" exactly once and "tool and hook feedback" exactly once, never inside the Intent Gate. RED on main: 30 of 30 app prompts failed.

### Why

- See `dynamic-prompt/changes.md` (2026-09-30): on the app surface the claim audit, not the Intent Gate, decides whether an unavailable check reaches the user, so each core's audit carries the rule and the feedback guidance lives there alone.

### Why an extension could not handle it

- This is the prompt-preset extension itself; the claim-audit wording lives inside each core.

### Expected merge conflict zones

- Fork-only files. The claim-audit and final-message sentences of each core, the `INTENT_GATE_LEAD.app` strings, and `SURFACE_DIRECTIVE` in `gpt-6-astra.ts`.

## 2026-09-30 - Venice's dotless gpt-61-sol resolves to the GPT-6 family preset (senpi#2390)

### What changed

- `presets.ts` `hasGpt6FamilySignal`: the point-release group also accepts one digit glued to the 6 (`gpt[._-]?6(?:[._-]\d+|\d)?[._-](astra|sol|luna)`), so `openai-gpt-61-sol` renders the `gpt-6-astra` preset. Bare `gpt-61` and `gpt-611-sol` stay unmatched (single digit only).
- `test/suite/prompt-presets-gpt-6-family.test.ts`: the Venice id joins the shape matrix (RED on the previous regex), and the non-family list gains `gpt-61` and `gpt-611-sol`; the catalog sweep matcher is widened the same way.

### Why

Venice publishes `openai-gpt-61-sol` (as it does `openai-gpt-56-sol`); without this the row ran on the generic prompt while every other GPT-6.1 Sol row used the family preset.

### Why an extension could not handle it

Preset matching is this extension.

### Expected merge conflict zones

- `presets.ts`: the GPT-6 matcher block near the top.

## 2026-09-30 - GPT-6.1 Sol resolves to the GPT-6 family preset; two writing rules from codex's 6.1 Sol template (senpi#2390)

### What changed

- `presets.ts` `hasGpt6FamilySignal`: the tier marker accepts an optional point release (`gpt[._-]?6(?:[._-]\d+)?[._-](astra|sol|luna)`), so `gpt-6.1-sol`, `gpt-6.1-sol-fast`, `openai/gpt-6.1-sol`, `GPT-6.1-Sol` and the display name "GPT-6.1 Sol" render the `gpt-6-astra` preset. Bare `gpt-6.1`, `gpt-6-mini` and near-miss words stay unmatched.
- `gpt-6-astra.ts`: new rule `no-reflexive-apology` (concern `writing-style`, rendered once in `## Writing` after `direct-statements`): "Apologize or fault yourself only for an avoidable mistake of your own, and then plainly: acknowledge it, correct it, move on. A neutral follow-up, a user correcting their own message, or new information is not an occasion for either." `direct-statements` adds "what something is not" to the announcements to skip. The rendered prompt grows from 2,925 to 2,968 words; nothing else in the core moves. Both rules render for every GPT-6 tier: the builder never sees the model, `promptPreset: "gpt-6-astra"` is one byte-stable prompt, and OpenAI's GPT-6 guide shares its practices across the family.
- `test/suite/prompt-presets-gpt-6-family.test.ts`: 6.1 Sol id shapes (base, `-fast` on the Codex lane, OpenRouter, Vercel `-fast`, display-name cased id), display-name resolution, byte-identical render against Astra, the apply_patch gate agreement, and the catalog sweep (matcher widened the same way). `test/suite/prompt-presets-gpt-6-astra.test.ts`: `no-reflexive-apology` pinned to `writing-style` / `Writing`.

### Why

OpenAI released GPT-6.1 Sol on 2026-09-29. openai/codex ships it the Astra template plus exactly two edits no other tier received: the paragraph against reflexive apologies and self-blame, and "what something is not" in the negation-avoid list. Those are OpenAI's only first-party, trace-derived signals about this model, and this preset addressed neither prior (category C, missing context). Everything else in codex's 6.1 Sol template was mapped section by section against this core and is either already carried (permission-as-final-step, steering, initiative, writing style, technical communication, PR descriptions, batching rules, skills precedence, no tool messaging) or left out on purpose (commentary channel, file-link syntax, apps, plugins). No senpi trace of 6.1 Sol exists yet, so no Astra-observed rule was removed on its account. The apology rule is positive-framed and 40 words against codex's 55.

### Why an extension could not handle it

Preset matching and the GPT-6 core are this extension; a user extension could only re-implement the whole dispatch.

### Expected merge conflict zones

- `presets.ts`: the GPT-6 matcher block near the top.
- `gpt-6-astra.ts`: the `Gpt6AstraRuleId` union, the `DIRECT_STATEMENTS` / `NO_REFLEXIVE_APOLOGY` constants, `GPT6_ASTRA_RULES`, and the `## Writing` line of the core.

## 2026-09-29 - App prompt surface for every preset (senpi#2377)

### What changed

- Every preset renders a `surface: "app"` variant (`SENPI_PROMPT_SURFACE=app`, see `dynamic-prompt/changes.md`); `terminal` renders are byte-identical to before. Shared-core presets (claude-opus-4-x, deepseek, glm, gpt-5 through 5.4, kimi-k2-x) take the shared intent gate and handoff app wording.
- `claude-fable-5.ts`, `claude-fable-5-1.ts`, `claude-opus-5.ts`, `claude-opus-5-5.ts`, `claude-sonnet-5-5.ts`, `kimi-k3.ts`, `grok-4.5.ts`, `grok-4.6.ts`, `grok-4.7.ts`: the Intent Gate lead is an `INTENT_GATE_LEAD: Record<PromptSurface, string>` whose `terminal` entry is the old text verbatim; the `app` entry keeps each core's stop-condition and scaffolding rules in its own wording, drops the routing line, and adds the core's tool-and-hook-feedback sentence. `buildHandoffSection` receives `surface: context.surface`. `kimi-k3.ts`: "Before the routing line, reread ..." reads "Before you act, reread ..." on `app`.
- `gpt-5.5.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts`: same `INTENT_GATE_LEAD` shape; the inline handoff moments come from `GPT_HANDOFF_MOMENTS` and the feedback sentence from `GPT_APP_FEEDBACK` in the new `gpt-surface.ts`. Astra keeps `GPT6_ASTRA_RULES` as the terminal wording and derives its `app` steering and handoff-report directives from it (`SURFACE_DIRECTIVE`), dropping "rather than another routing line" and the routing-line moment.
- `claude-fable-5.ts`, `grok-4.6.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts`: "your declared stop condition" (context-limit line, Stop Goal) reads "your stop condition" on `app`, so no app prompt asks for a declared, i.e. written-out, condition.
- `kimi-k2-6.ts`, `kimi-k2-code.ts`: the "The intent gate routing line is required every turn." sentence is omitted on `app`.
- `presets.ts` `withDefaults` and `index.ts` `eventOptionsToBuilderInput` carry `surface` from the session's system-prompt options; `settings.ts` exports `VALID_PRESETS` so the surface suite iterates every preset name.
- `test/suite/prompt-presets-app-surface.test.ts` (new): for the dynamic prompt and every `VALID_PRESETS` name, `app` has no "I read this as" / "routing line" and has the feedback guidance; `terminal` (omitted and explicit) keeps the routing line; `resolvePromptSurface` accepts only `app`; a harness session with `SENPI_PROMPT_SURFACE=app` renders the app prompt for a preset model and the fallback prompt.

### Why

- The routing line is a terminal contract; an app host renders replies as chat, where the line and relayed tool notices read as harness chatter (omo-desktop-app#1313). Per-core wording keeps each model's dialect; one `app` entry per core replaces the lead at its source instead of appending a counter-rule.

### Why an extension could not handle it

- This is the prompt-preset extension itself; the lead text lives inside each core.

### Expected merge conflict zones

- Fork-only files. The `INTENT_GATE_LEAD` declarations above each `build*Core`, and the handoff call sites.

## 2026-09-29 - Claude Sonnet 5.5 preset (senpi#2321)

### What changed

- `claude-sonnet-5-5.ts` (new): the `claude-opus-5-5` core with the Sonnet 5.5 guide's coding-agent deltas applied at the sentence they replace, one home per rule (prompt-engineering A/B/C pass, no rule appended): `## Style` names the three early stops the guide documents at low and medium effort (confirming a plan the request already settles, asking a self-answerable question, stopping after one part of a multipart task) in place of the Opus 5.5 "unattended run" endings; `## Scope` widens the tests-only clause to tests, docs and supporting files and carries the guide's mention-at-the-end remedy; `## Verification` folds the guide's "a check that failed to start does not count; install declared deps with the project's own package manager; name the unrun check" into the existing "run the validator" sentence; the Opus 5.5 time-as-cost delegation sentence is dropped (undocumented for Sonnet). Unchanged: Intent Gate and its stop condition, explore-before-acting, the claim audit, the Handoff block, no reasoning-in-text lines.
- `presets.ts`: `CLAUDE_SONNET_55_MARKERS` (`sonnet-5-5`, `sonnet-5.5`) resolve to `claude-sonnet-5-5` after the Opus matchers; Sonnet 5 and Sonnet 4.x keep the default dynamic prompt. `settings.ts`: the name joins `PromptPresetName` and `VALID_PRESETS`.
- `test/suite/prompt-presets-claude-sonnet-5-5.test.ts` (new): id shapes (dashed, dotted, dated, Bedrock, Vertex, display name), non-matches (Sonnet 5, Opus 5.5, `sonnet-55`), forced preset, catalog sweep.

### Why

- Anthropic's Sonnet 5.5 guide (2026-09-28) says Sonnet 5 prompts carry over and documents three low/medium-effort early stops, supporting-file over-delivery, and reporting a change done without a runnable check. Each maps onto a sentence the Opus 5.5 core already has, so the delta is a replacement, not growth.

### Why an extension could not handle it

- Preset dispatch lives in this builtin.

### Expected merge conflict zones

- LOW: the Claude matcher block and the `buildPreset` switch in `presets.ts`; `claude-sonnet-5-5.ts` is fork-only.


## 2026-09-28 - GPT-6 Astra: the stated goal bounds the work (#2256)

### What changed

- `gpt-6-astra.ts` (shared by GPT-6 Sol / Luna), five replacements at the sentences that licensed going deeper than the goal. The preset shrinks from 2956 to 2923 words (17,501 to 17,329 rendered chars), and no rule was appended.
  - `## Working the Task`: `; a finding that looks too simple deserves one more layer of callers or dependencies, and the root fix beats the symptom fix.` -> `, and fix the root cause rather than the symptom.` (B: the escalation clause overrode the stop rule in the same sentence; the root-cause half is kept).
  - `## Verification`: `, where a defect found in use is yours to fix this turn` deleted (A: it contradicted "fix failures your change caused and report pre-existing ones" in the same section and the Scope paragraph, and it is the literal order behind the reported detour).
  - `## Scope and Recovery`: `A pre-existing bug or cleanup opportunity beside your change goes in the final message while the diff stays focused.` -> `Errors, bugs, and cleanup opportunities outside the stated goal, including ones you run into along the way, go in the final message unexplored unless one blocks the goal.` (B plus a gap: the old sentence bounded the diff, not the tool calls; this is the one positive scoping principle).
  - `eval-first-routing`: `; an extra read-only call in that wave is nearly free, while a stale assumption costs the turn` deleted (B: a rationale that read as a license for speculative reads; the batching directive itself is unchanged).
  - `monitor-conditions`: `EVERY CONDITION YOU WOULD OTHERWISE CHECK ON` -> `... WAIT ON` (B: the caps rule made Astra subscribe even to a 100 ms test run and end the turn, which contradicted `foreground-exception`; the 2026-09-05 long-wait behavior is what "wait on" names).
- Unchanged on purpose: the 2026-09-11 set (`unbounded-retry`, `turn-end-is-wait`, `approval-last`, the handoff stands-in clause), the Stop Goal, Hard Limits, the shared test decision, and every skill-loading sentence (`skills.ts` catalog line, `bun-runtime`, the eval description's bun-1-4 line), which are out of scope per the owner.

### Why

A user gave GPT-6 Astra (`low`) a clear goal and acceptance criteria; it found an unrelated page error and debugged it until told to refocus. Every emphasized or escalating instruction Astra receives was enumerated and judged keep / soften / delete (table in the PR). The five above were the ones whose wording turns a side finding into owned work or makes extra depth free. Real-model A/B at `low` (RPC surface, before vs after, n = 4-5 per arm per task, effort `low`): on the planted-error task off-goal runs fell 2/4 -> 0/4 with calls 13.0 -> 12.0; a root-cause bug fix and an 11-key multi-step task (the 09-11 early-stop shape) kept 4/4 success and 0 early stops; the rename task was unchanged (its remaining overhead is skill reads, which stay). Harness and raw events are kept outside the repo.

### Why an extension could not handle it

The sentences are preset core text and rule data; an extension could only append a competing rule after them.

### Expected merge conflict zones

- `gpt-6-astra.ts`: `EVAL_FIRST_ROUTING`, `MONITOR_CONDITIONS`, the `## Working the Task`, `## Verification`, and `## Scope and Recovery` template paragraphs, and the header comment. Fork-only file.

## 2026-09-24 - GPT cores: the routing line is not a handoff (real-surface QA)

### What changed

- `gpt-5.5.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts` (`handoff-report` directive): `At a handoff - turn start, a todo phase change, ...` -> `At a handoff - the todo list's creation (in the message that creates it, after the routing line, or the next one), a todo phase change, a blocker or plan change, the final message; the routing line is not one - ...`. Mirrors the shared-core `handoff.ts` rewording (`dynamic-prompt/changes.md`); the Claude, Kimi, and Grok cores render the shared builder and pick it up there. +9 words per GPT core.
- The final-message rule in every core that states one is merged into the handoff block instead of competing with it: `claude-fable-5.ts`, `claude-fable-5-1.ts`, `kimi-k3.ts` ("The final message opens with the Handoff block; its/write its For you slot ..."), `claude-opus-5.ts`, `claude-opus-5-5.ts` ("When you finish, open with the Handoff block; its For you slot answers ..."), `gpt-5.5.ts` ("The final message is the Handoff block: its outcome and You need slots carry the result and its verification ..."), `gpt-5.6.ts` ("Final message: the Handoff block, whose outcome leads and whose You need slot carries the evidence ..."), `gpt-6-astra.ts` `FINAL_MESSAGE_SHAPE` ("The final message is the handoff block and stands alone ..."), `grok-4.5.ts` ("the final message is the Handoff block, whose For you slot leads with the outcome ..."). The outcome-first content of each rule is kept; only its container changes. +2 to +11 words per core. `prompt-presets-extension.test.ts` pinned the old gpt-5.6 wording (`Lead with the conclusion`) as a presence marker; it now pins the section label `Final message:` (a structural marker, not the prose).

- `claude-fable-5-1.ts`: `buildHandoffSection({ turnEndRuleStatedElsewhere: true, briefUpdatesBetweenHandoffs: true })`. Third QA finding: with the final message fixed, `claude-fable-5-1` still wrote nothing between the todo init and the final message - no handoff at the plan or at any phase change - which is the guide's documented default ("Ask for user-facing progress updates": 5.1 writes fewer updates than Fable 5 during long tool chains; remedy: remove narration-suppressing lines first, then say when updates are wanted). The only suppressing line it saw was the shared `Between handoffs, work without narration.`; for this family it becomes the guide's positive form, carrying the Now/Next labels so the update names the todo state. Measured on single runs: the unlabeled form produced findings lines with no todo state, the labeled form produced findings + Now + Next at each phase change. Other families keep the quiet default: grok-4.7 passed with it and no other family has a documented under-reporting default. +12 words in the fable-5-1 core.

### Why

- Second QA finding: on the re-run `claude-fable-5-1` wrote no handoff block at all and closed with a free-form outcome-first summary, because each core's final-summary rule and `## Handoff` both claimed the final message. Merging them leaves one rule per message.
- Category B: on the real `xai/grok-4.7` run the routing line satisfied "turn start" in the model's reading, so the first handoff block only appeared in the final message. Naming the moment by state (the plan now exists) removes the ambiguity in every family at once.

### Why an extension could not handle it

- Preset core text; an extension could only append a competing definition.

### Expected merge conflict zones

- The `## Handoff` paragraph of `gpt-5.5.ts` / `gpt-5.6.ts` and the `HANDOFF_REPORT` constant in `gpt-6-astra.ts`. Fork-only files.

## 2026-09-24 - Grok 4.7 tuned against the field trace; the 4.6 byte-copy contract retired

### What changed

- `grok-4.7.ts`: the file stops being a verbatim copy of `grok-4.6.ts` (the 2026-09-22 copy ruling below, senpi#1990, anticipated exactly this: the copy and its equality test retire together when 4.7 gets its own tuning). Edits, each against the full-day Grok 4.7 field trace (stopped early repeatedly, claimed done with open work, did not decompose a five-step natural-language build request, gave no visibility), with no vendor prompting guide for 4.7 to lean on:
  - A: `You are ${APP_NAME}, a coding agent running on Grok 4.6 - a fast, decisive daily driver.` -> `... running on Grok 4.7.`
  - B: Intent Gate paragraph 2 (`Before naming the stop condition, decide what done actually means ... is a defect, not diligence.`, an over-work warning while the observed failure is early stopping) -> `Done means the deliverable the user asked for exists and they can see it working - never a plan, a partial, or a report about it. Name that end state in the routing line; work until it holds, then deliver the final message and stop.`
  - B: routes `"what do you think about X?": judge and propose; wait for confirmation.` -> `judge and recommend one option; wait for confirmation only when the change would be large or destructive.`; `"refactor" / "improve" / "clean up": assess first, propose an approach.` -> `assess, then make the smallest change that meets the goal; propose first only when it would be large or destructive.`
  - C: appended route `A request that names a deliverable - build, make, create, do X then Y - is implementation however it is phrased; a multi-step request is one deliverable executed in order.`
  - C: the grok-4.6 treatment - `buildHandoffSection()` as `## Handoff` before `## Style`, the dense/quiet/never-restate paragraph deleted, the announcement ban reduced to permission-begging, and the full completion bullet in `## Hard Limits`.
  - A (paying for the growth; each rule keeps one home): `; open-ended ones take the smallest path that fully satisfies the goal` (the refactor route now says it), `- Never speculate about code, tests, or runtime behavior you have not read or verified.` (the Working the Task re-read rule; kimi-k3 made the same cut), `Concise, concrete` (brevity adjective), `Keep working until your declared stop condition is met.` (the new stop paragraph).
  - Header: the first paragraph now records the trace, the missing vendor guide, and the A/B/C edits; the 4.6 field-guide findings stay (explicit done beats exhortation), and the file names no `Grok 4.6` string.
- `test/suite/prompt-presets-grok-4-7.test.ts`: both byte-equality assertions against 4.6 and the `buildGrok46Prompt` import are gone. The built prompt is now checked with sentinels: `toContain("running on Grok 4.7")`, `not.toContain("Grok 4.6")`, `occurrences(prompt, "## Handoff") === 1`, `toContain("## Intent Gate")`. Each went RED under a one-line mutation first (4.6 self-id restored; a `Grok 4.6` leak with the 4.7 self-id kept; Handoff rendered twice; Intent Gate heading renamed). The settings-force case asserts `running on Grok 4.7` instead of `Grok 4.6`.
- `AGENTS.md`: the covered-family list names grok-4.5, grok-4.6, and grok-4.7 (its own tuned core).

Rendered `wc -w` (empty tool list, `resolvePreset` settings force): 1057 -> 1130 (+73).

| Delta | Words | Category |
|-------|-------|----------|
| Self-id line | -6 | A |
| Intent Gate paragraph 2 | -14 | B |
| Judgment + refactor routes | +26 | B |
| Deliverable route (new) | +31 | C |
| `## Handoff` (+122) minus quiet paragraph (-78) and announcement ban (-6) | +38 | B+C |
| Completion bullet | +36 | C |
| Four redundant deletions | -38 | A |

Net B is +12 (the two route rewrites add their large-or-destructive conditions and the stop paragraph shrinks by 14); the growth past the bullet plus the net handoff delta (+74) is paid by the four A deletions, so the file ends 1 word under it.

### Why

senpi#2121. The field trace shows the 4.6 posture failing on 4.7 in the opposite direction from what the 4.6 text guards against: the stop paragraph warned against doing too much, the routes told the model to propose and wait, and the Style section told it to stay quiet. The gajae-code routing stance (a directly implementable request is implemented) and its completion contract informed the route and bullet wording.

### Why an extension could not handle it

The preset core text and its test are this builtin's own; an extension could only append after the contradicting sentences.

### Expected merge conflict zones

- `grok-4.7.ts` header, Intent Gate, `## Hard Limits`, `## Style`; `prompt-presets-grok-4-7.test.ts` imports and the replaced case. Fork-only files.

## 2026-09-24 - Grok 4.5 and 4.6 cores: handoff contract and completion bullet

### What changed

- `grok-4.5.ts`: `buildHandoffSection()` renders `## Handoff` before `## Output` in place of the Output's first sentence; the CEO/orchestration and delegation text is untouched. Full completion bullet in `## Hard Limits` (no scope-swap sentence in this core). Header rationale line.
- `grok-4.6.ts`: the first `## Style` paragraph is deleted and `## Handoff` renders before `## Style`; the announcement ban becomes a permission-begging ban; full completion bullet in `## Hard Limits`. Header finding 3 now says the Handoff block's fixed fields cover the over-reporting half. Header rationale line. This commit leaves `grok-4.7.ts` a stale copy, and `prompt-presets-grok-4-7.test.ts`'s byte-equality assertion fails until the next entry retires it.

Removed sentences and rendered `wc -w` (empty tool list, `resolvePreset` settings force):

| Preset | Removed (exact) | Before | After | Delta by category |
|--------|-----------------|--------|-------|-------------------|
| grok-4.5 | `Update only at meaningful phase changes — a discovery that changes the plan, a worker returning, a blocker — one sentence each.` | 780 | 916 | +122 handoff B+C; +36 full completion bullet C; -22 phase-change cadence B |
| grok-4.6 | `Make every report dense with information the user does not already have: lead with the outcome and what you verified, never restate the task back. While working, stay quiet through small changes and give one short update only at a meaningful phase change - a discovery that changes the plan, a blocker, work spanning many files - with enough substance to let the user decide whether to interrupt. Skip anything the user does not need to act on.`; `announcement language ("Next, I will...") and permission-begging ("Shall I?") are prohibited` -> `permission-begging ("Shall I?") is prohibited` | 1057 | 1131 | +122 handoff B+C; +36 full completion bullet C; -78 quiet/never-restate paragraph B; -6 announcement ban B |

Neither file grew beyond its completion bullet plus the net handoff delta.

### Why

senpi#2121 (user directive 2026-09-24): progress must be legible at every phase change and at the end. Both Grok cores told the model to stay quiet until a "meaningful" phase change and banned announcing the next step, and the Grok field trace behind this issue shows silent runs that ended with done claimed while work was still open. No xAI prompting guide covers progress reporting; the 4.6 field guide's finding that an explicit definition beats exhortation is why the replacement is a fixed block with named moments, not a frequency word.

### Why an extension could not handle it

The sentences are preset core text; an extension could only append a contradicting rule after them.

### Expected merge conflict zones

- `grok-4.5.ts` `## Hard Limits` / `## Output` opening; `grok-4.6.ts` `## Hard Limits` / `## Style` opening; both import blocks and headers. Fork-only files.

## 2026-09-24 - GPT cores: outcome-first handoff; Astra handoff-report rule

### What changed

- `gpt-5.5.ts`: `## Handoff` (outcome-first block: `[Outcome so far] toward [...]. You need: [...]. Now: [...]. Next: [...]`) inserted before `## Style`; full completion bullet in `## Hard Limits` (the core bans widening only, not swap); header rationale line.
- `gpt-5.6.ts`: the same `## Handoff` section before `## Output`; the short completion bullet (`## Output` already says "never substitute a shorter artifact for the one asked for" and the Stop Goal "no partial delivery"); `Final message:`, `Code reviews:`, the Stop Goal, and `GPT56_EXECUTION_RULES` untouched; header rationale line, and the header's quoted brevity phrase reworded.
- `gpt-6-astra.ts`: new rule `handoff-report` (concern `reporting`) renders once in `## Reporting` in place of the plan-change sentence, ending with that sentence's clause "a plan, a hypothesis, a status report, or an offer to continue never stands in for the work"; no heading and no bold (the `## Reporting` section is the heading, and bold stays reserved for the async rules). `DIRECT_STATEMENTS` untouched. Short completion bullet in `## Hard Limits` (`initiative-bias` already says "deliver all of it and only it"). Header rationale line.
- `test/suite/prompt-presets-gpt-6-astra.test.ts`: `handoff-report` -> `reporting` -> `Reporting` in both rule tables; the emphasized set is unchanged, so the rule is asserted plain. RED under four one-line mutations (rendered in `## Writing`, rendered twice, concern `writing-style`, bold added) before green. `prompt-presets-gpt-6-family.test.ts` (Sol/Luna byte-equal to Astra) stays green unchanged.

Removed sentences and rendered `wc -w` (empty tool list, `resolvePreset` settings force):

| Preset | Removed (exact) | Before | After | Delta by category |
|--------|-----------------|--------|-------|-------------------|
| gpt-5.5 | `, and roadmap language ("Next, I will") - do the follow-up now and report it done` (the sentence now ends at the permission-begging ban) | 882 | 998 | +94 handoff B+C; +36 full completion bullet C; -14 roadmap ban B (contradicted the handoff's Next) |
| gpt-5.6 | `During work, update only at meaningful phase changes - a plan-changing discovery, a tradeoff decision, a blocker - one sentence each; never narrate routine reads.`; `Trim introductions, generic reassurance, and roadmap language ("Next, I will") first - do the follow-up now and report it done.` -> `Trim introductions and generic reassurance first.`; `say so concisely` -> `say so in a sentence` | 2116 | 2201 | +94 handoff B+C; +28 short bullet C; -25 phase-change cadence B; -14 roadmap ban B; +2 brevity adjective replaced by a bound A |
| gpt-6-astra (and Sol/Luna) | `While working, speak only when something changes the plan - a finding, a tradeoff decision, a blocker - in one or two sentences naming the concrete outcome and the next step, then take that step in the same turn: a plan, a hypothesis, a status report, or an offer to continue never stands in for the work. Routine reads and passing checks go unnarrated.` | 2778 | 2852 | +110 handoff-report B+C (keeps the stands-in clause); -64 plan-change sentence B; +28 short bullet C |

No file grew beyond its completion bullet plus the net handoff delta. None of the three files contains `concise` or `keep it short` after this change.

### Why

senpi#2121 (user directive 2026-09-24): progress must be legible at every phase change and at the end. The GPT cores rationed updates to plan-changing discoveries and banned roadmap language, so a run could go silent and a named Next read as forbidden. The GPT-5.5 guide asks for a short visible preamble and sparse outcome-based updates at major phase changes, never narration of routine calls; the GPT-5.6 guide ("Simplify prompts first") asks that added text replace, not stack, so each section is paid for by the sentences it supersedes, and no brevity adjective is added (GPT-5.6 over-compresses under them). Astra keeps its 09-11 closing clause because that survey showed it ending turns on a named next step it never took.

### Why an extension could not handle it

The sentences are preset core text and rule data; an extension could only append a contradicting rule after them.

### Expected merge conflict zones

- `gpt-5.5.ts` / `gpt-5.6.ts` `## Hard Limits` tails and the `## Style` / `## Output` openings; `gpt-6-astra.ts` rule-id union, `GPT6_ASTRA_RULES`, `## Reporting`, `## Hard Limits`; the astra test's two rule tables. Fork-only files.

## 2026-09-24 - Claude and Kimi K3 cores: handoff contract replaces quiet narration

### What changed

- `claude-fable-5.ts`, `claude-fable-5-1.ts`, `claude-opus-5.ts`, `claude-opus-5-5.ts`, `kimi-k3.ts`: each renders `buildHandoffSection({ turnEndRuleStatedElsewhere: true })` (`dynamic-prompt/handoff.ts`) as `## Handoff` immediately before its `## Style`, gains a completion bullet in `## Hard Limits`, and gets a one-line header rationale. Every one of these cores already carries a text-only turn-end rule ("check your last paragraph", or the Opus 5.5 four endings), so the block's "a Next with nothing after it is a defect" clause is dropped there instead of stated twice. Completion bullet: the short form where the core already bans scope swap (fable-5-1, opus-5, opus-5-5 Scope sections; kimi-k3 "deliver all of it and only it ... scaling the task down is the user's call"), the full form in fable-5 (no scope-swap sentence).
- `kimi-k2-code.ts` (thin, shared by K2.7/K2.8): `Write lean - do not restate the request or re-derive what you already established this turn.` -> `Write lean - do not re-derive what you already established this turn.` (the rendered shared core now asks for an Ask field). The only thin-preset edit.

Removed sentences and rendered `wc -w` (empty tool list, `resolvePreset` settings force; renders in the lane evidence `task-7-<preset>.before/.after.md`):

| Preset | Removed (exact) | Before | After | Delta by category |
|--------|-----------------|--------|-------|-------------------|
| claude-fable-5 | `Announcement language ("Next, I will...") and permission-begging ("Shall I?") are prohibited.` -> `Permission-begging ("Shall I?") is prohibited.`; `Be concise and concrete: no filler openers, no self-praise,` (default traits, brevity adjective); `Terse shorthand between tool calls is fine;` (licensed the narration the handoff forbids; "see it" -> "see the work" to keep the sentence whole) | 1083 | 1211 | +113 handoff B+C; +36 full completion bullet C; -6 announcement B; -9 concise traits A; -7 shorthand allowance B; +1 referent |
| claude-fable-5-1 | `Add a brief progress note when you learn something important or change direction.` | 1097 | 1225 | +113 handoff B+C; +28 short bullet C; -13 progress-note cadence B |
| claude-opus-5 | `The routing line already announced the plan, so add a brief update only when you find something important or change direction, and correct an earlier statement ...` -> `Correct an earlier statement ...` (correction filter kept) | 1253 | 1372 | +113 handoff B+C; +28 short bullet C; -22 cadence clause B |
| claude-opus-5-5 | same clause as claude-opus-5 | 1348 | 1467 | +113 handoff B+C; +28 short bullet C; -22 cadence clause B |
| kimi-k3 | `Do not restate the request, re-derive facts ...` -> `Do not re-derive facts ...` | 1303 | 1441 | +113 handoff B+C; +28 short bullet C; -3 restate ban B |
| kimi-k2-7 / kimi-k2-8 | `do not restate the request or` | 1416 | 1412 | -4 restate ban B |

No file grew beyond its completion bullet plus the net handoff delta, so no further deletion was owed.

### Why

senpi#2121: the user directive of 2026-09-24 asks that progress be legible at every phase change and at the end - what was asked, what the user needs to know, what runs now, what runs next. These cores either banned announcements outright or rationed updates to "something important", which produced silent runs. Anthropic's guides describe the lever as the shape of updates, not a cadence counter (claude.md "User-facing progress updates"; Opus 5 "User-facing progress updates"; Fable 5.1 "Ask for user-facing progress updates": remove narration-suppressing lines first; Opus 5.5 "User-facing progress updates"). Kimi's guide asks for objective conditions and a stated replacement behavior (kimi.md "Explicit terminal conditions"). The request-restating bans conflicted with the handoff's Ask field.

### Why an extension could not handle it

The sentences are preset core text; an extension could only append a contradicting rule after them.

### Expected merge conflict zones

- The five cores' `## Hard Limits` tails, `## Style` paragraphs, imports, and header comments; `kimi-k2-code.ts` tuning sentence. Fork-only files.

## 2026-09-23 - GPT presets: the test decision replaces test-first

### What changed

- `test-decision.ts` (new): one shared `TEST_DECISION` directive rendered by both GPT full-core presets. Read the existing tests first as the behavior of record (a test that contradicts the intent is a finding, not a test to edit green); reproduce a bug before fixing it; the run proves the change, and a test is added only where the repository keeps tests for this behavior AND a regression would otherwise pass unnoticed, sized like its neighbors and never restating the change.
- `gpt-5.6.ts`: `TEST_FIRST` deleted; rule id `test-first` -> `test-decision`, concern `test-first` -> `tests`; the directive moved from the end of `## Pragmatism & Scope` into `## Verification`, between the validator line and the shared Test Discipline block. Rendered constant 409 -> 363 chars.
- `gpt-6-astra.ts`: `TEST_FIRST` deleted; same id/concern rename; the directive keeps its `## Verification` slot. 359 -> 363 chars (+4; the exemption list is gone, the decision criterion is new).
- `test/suite/prompt-presets-gpt-5-6.test.ts`, `prompt-presets-gpt-6-astra.test.ts`: rule-id -> concern/section maps updated; the two cross-preset leak checks skip `test-decision` because it is single-sourced on purpose; the 5.6 case that asserted `apply_patch` under a "drops the anti-test default" title is renamed to what it checks.

### Why

- Test-first made a test the proof of every change with a seam. Any simple edit inside a tested module has a seam, so the rule mandated tests that could only restate the change; the harness then grew counter-rules (`prompt-behavior-coverage`, reviewer slop passes) to catch them, and the Astra header itself recorded "over-tests small changes". The decision now sits where an engineer makes it, with two observable conditions instead of a ritual order. The Claude and Kimi presets already carried this stance in their Scope paragraph ("commit tests only where the task asks for them or the repository already keeps tests for that kind of change"); this brings the GPT presets in line and removes the contradiction between presets.
- Per the GPT-5.6 guide's simplify-first doctrine, the change deletes a process instruction and its exemption list; the only growth is the decision criterion.

### Why an extension could not handle it

The directive is preset core text; a user extension could only append a contradicting rule after it.

### Expected merge conflict zones

- `gpt-5.6.ts` / `gpt-6-astra.ts`: the rule-id unions, the `*_RULES` arrays, and the `## Verification` template block. Fork-only files; no upstream counterpart.

## 2026-09-23 - GPT-6 Sol / Luna resolve to the GPT-6 family preset

### What changed

- `presets.ts`: `hasGpt6AstraSignal` / `isGpt6AstraModel` become `hasGpt6FamilySignal` / `isGpt6FamilyModel`, matching `gpt-6-(astra|sol|luna)` with the same delimiter-boundary shape (prefixed ids such as `openai/gpt-6-sol`, `openai-gpt-6-luna`, `global.openai.gpt-6-sol`, suffixed `-fast` / dated snapshots / `:batch`, and the display names). The dispatch still returns `"gpt-6-astra"`; no new `PromptPresetName` and no new prompt file, because the rendered Astra core names no model and OpenAI's guide covers the family with one set of practices. Bare `gpt-6`, `gpt-6-mini`, `gpt-6.1` and near-miss words (`gpt-6-solaris`, `gpt-6-lunar`) stay unmatched.
- `test/suite/prompt-presets-gpt-6-family.test.ts`: id-shape matrix for Sol and Luna, display-name resolution, byte-identical prompt against Astra (and no `Astra` token in it), 5.6 ids stay on `gpt-5.6`, non-family ids stay out, the preset and `getApplyPatchWireMode` agree on the three Responses APIs (#1891 class), and every Sol/Luna row in the generated catalogs resolves.

### Why

Before this change a `gpt-6-sol` or `gpt-6-luna` session (the new catalog rows in this release) ran on the generic senpi prompt while Astra ran on the GPT-6 core, even though the family shares one prompting guide and the same tool gate (apply_patch freeform) already applied to all three.

### Why an extension could not handle it

Preset matching is this extension; a user extension could only re-implement the whole dispatch.

### Expected merge conflict zones

- `presets.ts`: the GPT-6 matcher block near the top and the first branch of `resolvePresetName`.

## 2026-09-22 - Claude Opus 5.5 preset

### What changed

- `claude-opus-5-5.ts`: new full-core preset via `corePrompt`. Anthropic's "Prompting Claude Opus 5.5" guide says Opus 5 prompts carry over, so the text is the dieted `claude-opus-5` core with the guide's coding-agent deltas applied at one home each (prompt-engineering A/B/C pass, nothing appended without replacing something):
  - Style: the guide's "Unattended agentic runs" section documents that 5.5 ends turns with text while work is still owed - a summary that announces the next step, an offer to continue unless told otherwise, a list of non-blocking decisions, or a milestone report - and that it responds to instructions naming those stops plus the stops that are wanted. The Opus 5 "check your last paragraph" sentence covered only the first and is replaced by a paragraph naming all four and the two legitimate stops (destructive action, user-only input), with status notes riding on the next tool call.
  - Working the Task: "Explore context in multi-app workflows" (look through the sources that could bear on a loosely specified task before changing anything) folded into the existing read-wide sentence; the Opus 5 delegation-cap paragraph reframed around "Time signals for multi-agent harnesses" (time spent is a cost; hand out only tracks whose parallel run finishes the task sooner).
  - Deliberately absent: think-carefully / reasoning-in-text lines (thinking is always on; `reasoning_extraction` is a refusal category), thinking-disabled artifact mitigations (thinking cannot be disabled), effort guidance (harness setting), pasted-content tags (user-message contract), frontend anti-pattern lists (project context owns design rules).
  - Probe (o200k, eval+monitor+task+todo selected, `/tmp/preset-probe-opus55-20260922/probe.ts`): claude-opus-5 1899 -> claude-opus-5-5 2002 tokens; the +103 is the stop-discipline paragraph after a trim pass (2023 before it).
- `presets.ts`: `isClaudeOpus55Model` (`opus-5-5` / `opus-5.5` markers, so Bedrock profiles, Vertex `@default`, and OpenRouter's dotted id all resolve) checked BEFORE the generic `opus-5` substring, which would otherwise swallow it; `claude-opus-5-5` dispatch case.
- `settings.ts`: `claude-opus-5-5` joins `PromptPresetName` and `VALID_PRESETS`.
- Tests: `test/suite/prompt-presets-claude-opus-5-5.test.ts` (id shapes, 5 stays on 5, settings force, catalog sweep), `prompt-presets-claude-opus-5.test.ts` excludes 5.5 from its catalog sweep and negative list, `brand-identity.test.ts` lists the new file and builder.

### Why

- `claude-opus-5-5` ids matched the `opus-5` substring and silently received the Opus 5 prompt, which lacks the turn-ending discipline the 5.5 guide documents as the model's new failure shape in unattended runs.

### Why an extension could not handle it

- Preset matching and the per-model cores live inside this builtin.

### Expected merge conflict zones

- LOW: `presets.ts` matcher block and dispatch switch; `settings.ts` union.

## 2026-09-22 - Render the File operations block from the active toolset (#1968)

### What changed

- `file-operations.ts`: `buildFileOperationsTuning({ toolNames })` now takes the session's active tool names and renders the verb that session actually has. `resolveFileMutationRouting()` returns `apply-patch` when `apply_patch` is active, `edit-write` naming whichever of `edit`/`write` are active, and `none` when the session cannot mutate files at all. The `read` paragraph, the `grep`-tool paragraph, and codex's "do not re-read after a successful `apply_patch`" guard are each emitted only when their tool is present; the anti-heredoc/`sed -i`/`awk -i`/inline-python guard rides the mutation sentence, so it appears in both editing branches.
- All eight callers pass it: `gpt-5.ts`, `gpt-5.2.ts`, `gpt-5.3-codex.ts` and `gpt-5.4.ts` thread `options.selectedTools` through their tuning builder; `gpt-5.5.ts`, `gpt-5.6.ts`, `gpt-6-astra.ts` and `grok-4.5.ts` read `context.tools` inside their `corePrompt` override.
- `grok-4.5.ts` no longer names `apply_patch` in its CEO role text either - the trivial-fix sentence just says to do them directly, leaving the File operations block as the single source of routing truth.
- Tests: new `test/suite/regressions/1968-file-operations-capability-routing.test.ts` pins the routing data and the invariant that a rendered preset never names a tool absent from its session. `prompt-presets-extension.test.ts` asserts each GPT preset in both session shapes instead of only asserting that `apply_patch` appears; `prompt-presets-grok-4-5.test.ts` had pinned the defect (`expect(prompt).toContain("apply_patch")` for a model that can never have it) and now asserts the opposite; the GPT-5.6 and GPT-6 Astra suites build with a patch-capable session.

### Why

- The block was emitted from preset identity, not capability. #1891 was one visible instance (a gateway-prefixed GPT id got the preset but not the tool, and the session stalled on `Tool apply_patch is registered but inactive`); #1942 stopped that deadlock by hedging the sentence into "when `apply_patch` is active ... otherwise ...", which left the cause in place and made the text name both tools in every session, so one of them was always absent.
- A second instance ships today: `grok-4.5.ts` calls this block while `apply_patch` is gated to GPT ids, which `grok-4.6.ts` already documents as the reason it dropped the call, and this file's own `AGENTS.md` already listed as an anti-pattern. A GPT preset pinned onto `anthropic-messages`/`bedrock-converse-stream`, or forced through the `promptPreset` setting, hits the same thing.
- The hedge also fought this file's documented wording rule. Positive routing beats a conditional the model has to resolve, and the block exists precisely because GPT's pretraining prior toward `sed`/heredoc is too strong for a weak instruction.

### Why an extension could not handle it

- The instruction and every preset that renders it live inside this builtin.

### Expected merge conflict zones

- MEDIUM: `file-operations.ts` - the whole builder is now parameterized.
- LOW: the eight preset call sites, each a one-line argument change.
- LOW: `grok-4.5.ts` role sentence.

## Grok 4.7 preset reusing Grok 4.6 verbatim (2026-09-22, senpi#1990)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/grok-4.7.ts`: standalone preset holding a VERBATIM copy of the Grok 4.6 prompt text — every section and string byte-identical, no import from grok-4.6.ts. Grok 4.7 has no prompt tuning yet, so any wording difference from the 4.6 prompt is a defect; the copy (not a delegation) is deliberate so this file is already the editable starting point when 4.7 gets its own tuning, and `test/suite/prompt-presets-grok-4-7.test.ts`'s byte-equality assertion is the load-bearing guard against the two copies drifting until then.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/presets.ts`: `hasGrok47Signal` / `isGrok47Model` in the existing regex family (same shapes as 4.6, minor version 7 — also covers Venice's dashed `grok-4-7`), a `grok-4.7` branch in `resolvePresetName` ahead of the 4.6 branch, and a `buildPreset` case.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/settings.ts`: `grok-4.7` joins `PromptPresetName` and `VALID_PRESETS`.
- `packages/coding-agent/test/suite/prompt-presets-grok-4-7.test.ts`: id-shape routing (incl. aggregator + dashed ids), byte-identical 4.6/4.7 builds, 4.6-stays-4.6 negatives, settings force, and catalog-wide coverage.

### Why

- `grok-4.7` ids matched neither the 4.5 nor the 4.6 matcher, so the model silently fell through to the untuned dynamic prompt.

### Why an extension could not handle it

- Preset registration is this builtin's own dispatch table.

### Expected merge conflict zones

- LOW: `presets.ts` branch order and `settings.ts` preset list on upstream syncs.
## 2026-09-21 - Route file edits through active tools (#1891)

### What changed

- `file-operations.ts`: the shared GPT instruction requires `apply_patch` when active and otherwise routes to available `edit`/`write` tools.

### Why

- The #1891 reproduction showed an unconditional patch-only instruction could demand an inactive tool. Unsupported APIs and custom ids must retain their available editing surface.

### Why an extension could not handle it

- The instruction is produced inside this builtin's shared preset helper.

### Expected merge conflict zones

- LOW: `file-operations.ts` file-mutation instruction.

## Kimi K2.8 Preview preset + Kimi Code rolling-id routing (2026-09-18)

### What changed

- `kimi-k2-code.ts` (new): the K2.7 tuning text moved here as `buildKimiK2CodePrompt(options, modelName)` - the execution-tooling stance in the `kimi` dialect plus the restrained outcome-first tuning, parameterized by the model name it announces. `kimi-k2-7.ts` and the new `kimi-k2-8.ts` are thin aliases over it (the `glm-5.ts` / `glm-5-{2,3}.ts` shape), so both prompts are byte-identical apart from `running on Kimi K2.7` / `running on Kimi K2.8`.
- `presets.ts`: added `hasKimiK28Signal` / `isKimiK28Model` and dispatched `kimi-k2-8` ahead of `kimi-k2-7`. Both Kimi matchers now also accept Kimi Code's rolling product ids by exact match - `kimi-for-coding` (K2.8 Preview) and `kimi-for-coding-highspeed` (K2.7 Code HighSpeed) - alongside the version-tagged `kimi-k2(.|p|-)8` shapes.
- `settings.ts`: `"kimi-k2-8"` joins `PromptPresetName` and `VALID_PRESETS`; `docs/settings.md`, this extension's `AGENTS.md`, and `builtin/AGENTS.md` list it.
- Tests: new `test/suite/prompt-presets-kimi-k2-8.test.ts` covers the id shapes, the display-name path, settings forcing, model-level `promptPreset` metadata, the live Kimi Code catalog rows, and a byte-equality assertion that the K2.8 prompt is the K2.7 prompt with the model name swapped. `prompt-presets-execution-tooling.test.ts` adds `kimi-k2-8` to `PRESET_DIALECT`.

### Why

- Moonshot rolled K2.8 Preview out across Kimi Code on 2026-09-11 and kept the model id unchanged, so every Kimi Code session has been served by K2.8 while resolving to no preset at all - the Kimi dialect, the workstation dialect, and the tuning were all missing. The published model table is the evidence for both mappings: <https://www.kimi.com/code/docs/en/kimi-code/models.html> (checked 2026-09-18).
- K2.8 is an efficiency and context upgrade inside the same K2 coding family rather than a new prompting contract, so it takes the K2.7 prompt verbatim instead of a bespoke one. Sharing a builder rather than copying the text keeps the two from drifting.
- Rolling product ids carry no version signal, so they are matched by exact equality and re-checked when Moonshot next upgrades an id in place.

### Why extension system couldn't handle this differently

- This is the builtin `prompt-preset` extension's own model-family dispatch; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- LOW: the `presets.ts` Kimi matcher block and the Kimi rows in `prompt-presets-extension.test.ts` if upstream adds its own Kimi aliases.
- LOW: `kimi-k2-code.ts` and `kimi-k2-8.ts` are new and fork-only; `kimi-k2-7.ts` shrank to an alias, so an upstream edit to its tuning text belongs in `kimi-k2-code.ts` instead.

## DeepSeek V4.1 Flash catalog drift: provider-presence assertions (2026-09-12)

### What changed

- Tests: `packages/coding-agent/test/suite/prompt-presets-deepseek-v4-1-flash.test.ts` - the catalog sweep pinned the literal rows `deepseek/deepseek-v4-flash`, `openrouter/deepseek/deepseek-v4.1-flash`, and `vercel-ai-gateway/deepseek/deepseek-v4.1-flash`. The 2026-09-12 catalog regeneration (upstream 12f59336a + 713bdf38d adopted on merge) renamed the official row `deepseek-v4-flash` -> `deepseek-flash` (V4 Flash retired 2026-09-10), so the pin went stale while resolution stayed correct. The sweep now asserts the V4.1 set carries at least one row from the official `deepseek` provider and one from `opencode-go` (which renames its id between regenerations), with the zero-miss resolution check unchanged.

### Why

- Preset resolution (`hasDeepseekV41FlashSignal` + `isRetiredOfficialDeepseekV4FlashAlias` in `presets.ts`) already matches the regenerated ids (`normalizeModelId` lowercases, `deepseek-flash` and every `v4.1`/`v4p1`/`v4-1` shape hit the signal regexes); only the test pinned one spelling. Provider presence keeps the sweep non-vacuous without re-introducing id drift.

### Expected merge conflict zones

- LOW: test-only; the catalog sweep assertion block.

## GPT-6 Astra: unbounded retries, a turn that ends only on a handle (2026-09-11)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts`: `failure-cap` is deleted and replaced by `unbounded-retry` (same `failure-recovery` concern, same `Scope and Recovery` home): no attempt limit, a material change per attempt, an empty or thin lookup widens to another source before absence is a fact, files are restored to the last known-good state before a fresh approach, and the user is brought in only for a decision that is theirs. `turn-end-is-wait` keeps its emphasis but now states the condition: the turn ends when a pending handle will wake the session, and with nothing pending and work still open it keeps going. `approval-last` asks only for an answer the session cannot supply, carries the cost of stopping, and defaults `wait_for_answer` to false (true only for an irreversible next step). The Reporting sentence requires the named next step to be taken in the same turn and rejects a plan, hypothesis, status report, or offer to continue as a substitute for the work.
- Tests: `packages/coding-agent/test/suite/prompt-presets-gpt-6-astra.test.ts` renames the rule id in both pinned tables and adds a contract case for the unbounded-retry and turn-end rules. The Reporting change is prose with no rule seam, so it ships with QA-by-read on the rendered prompt instead of a pinned sentence.

### Why

- A survey of the same 703 sessions found Astra ending 14.9% of its human-facing turns on a named next step it never took (claude-fable 3.0%, claude-opus 3.7%, kimi 3.1%), and 12.2% of them with open todos and no goal. Three rules produced that: `turn-end-is-wait` was the loudest rule in the file and made ending the turn unconditional; the Reporting sentence let announcing the next step stand in for taking it; and `failure-cap` capped attempts at three and terminated in a question, which for the model the Astra guide already describes as asking more and stopping earlier reads as permission to stop. Codex's own Astra template takes the opposite line ("Do not stop at acknowledging capability, proposing a plan, or offering to continue") and makes `request_user_input` non-blocking outside Plan mode, with Default mode telling the model to prefer reasonable assumptions and continue with best judgment.
- Token cost (o200k via gpt-tokenizer; eval, read, bash, monitor, task, todo, request_user_input, ask_user_question selected): gpt-6-astra 3584 -> 3628 (+44). The first draft measured +107; the turn-end rule had re-listed the handles `async-default` already names, and `stay-direct-exceptions` carried its own do-not-trust-absence clause beside the new retry rule, so both were folded into one home. The remaining growth is the same-turn clause in Reporting, the cost-of-stopping sentence in `approval-last`, and the widen-the-source clause in `unbounded-retry`, each of which names a failure the survey measured. Rule count unchanged at 28.

### Why an extension could not handle it

- Content-only change inside a builtin preset's rule data; the behavior it corrects is the preset's own wording.

### Expected merge conflict zones

- MEDIUM: `gpt-6-astra.ts` TURN_END_IS_WAIT / APPROVAL_LAST / the failure-recovery rule and the Reporting paragraph are edited often; the rule id rename touches both pinned tables in the preset suite.

## DeepSeek V4.1 Flash preset (2026-09-11)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/deepseek-v4-1-flash.ts`: new `deepseek-v4-1-flash` preset over the shared core - `buildExecutionToolingSection` in the claude dialect plus the claude workstation dialect, no tuning prose, and none of the `DEEPSEEK_V4_RULES`.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/presets.ts`: `hasDeepseekV41FlashSignal` matches `deepseek-flash` (the official API name, also opencode-go), `deepseek-v4.1-flash` / `deepseek/deepseek-v4.1-flash[:thinking]`, `deepseek-ai/DeepSeek-V4.1-Flash`, fireworks' `deepseek-v4p1-flash`, venice's `deepseek-v4-1-flash`, and the display name; `isRetiredOfficialDeepseekV4FlashAlias` routes `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` on the `deepseek` provider to the V4.1 preset, and only there - the same names on every other provider keep the V4 preset. Resolves after the dated 0731 snapshot and before the generic flash alias.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/settings.ts`: `deepseek-v4-1-flash` joins `PromptPresetName`.
- Tests: `packages/coding-agent/test/suite/prompt-presets-deepseek-v4-1-flash.test.ts` (id-shape table, retired-alias routing per provider, non-matching ids, settings forcing, zero-miss catalog sweep, no V4 rule in the prompt, execution-tooling rendered only with `eval`, claude workstation dialect); `prompt-presets-deepseek-v4.test.ts` excludes the official provider's flash alias from its catalog expectation and adds the V4.1 prompt to its no-leak list.
- Docs: `AGENTS.md` (this directory and `builtin/`), `docs/settings.md`.

### Why

- V4.1 Flash shipped 2026-09-10 (DeepSeek API changelog; `deepseek-flash` is the new name, V4 Flash and V4 Flash Vision Exp are retired and their names "temporarily routed to V4.1 Flash"). Every V4.1 id fell through `resolvePresetName` to the fallback prompt, and the official alias received the V4 Flash tuning for a model it no longer serves.
- Prompt content per the prompt-engineering skill: the four V4 rules are category-C repairs for failures observed on V4-Flash-0731 transcripts. V4.1 Flash is a new pre-train (552B Causal Encoder-Decoder MoE, 45T tokens from scratch, RL across Claude Code / OpenCode / Pi / mini-SWE / DeepSeek Harness), so carrying those rules over would be a patch without a diagnosis. DeepSeek's own scaffold comparison (tech report Table 4, same checkpoint, max effort) puts the thinnest harness first: DSH Minimal - complete system prompt `You are a helpful software engineer assistant.` plus one bash tool - scores 90.6 on Terminal-Bench 2.1 vs 85.8 for DSH Standard, and mini-SWE / DSH Minimal lead DeepSWE v1.1 (74.2 / 72.6) over Claude Code 69.8, Pi 66.2, OpenCode 65.5; Appendix B.1: "We add no experimental system prompt." The preset therefore adds nothing the model already carries and keeps only senpi's own contract (routing line, stop condition, hard limits) and the eval-routing decision the tool description cannot make.
- Token cost (o200k via gpt-tokenizer; read, edit, write, bash, eval, todo, grep, glob, task, ask_user_question selected; empty snippets): fallback 1566, deepseek-v4-flash 1909, deepseek-v4-1-flash 1835 with `eval` (the execution-tooling block) and 1557 without. The official-provider alias drops 74 tokens of V4 repair prose it no longer needs.
- A V4.1-specific rule is added only against a V4.1 trace, by listing the preset in that rule's `presets`; the new test pins that no V4 rule leaks in by default.

### Why extension system couldn't handle this differently

- Preset matching is builtin extension data; a user can still force any preset through `promptPreset` in settings.

### Expected merge conflict zones on next upstream sync

- LOW: `presets.ts` matcher block and `resolvePresetName` order; `settings.ts` union.

## Route user questions through the question tool (2026-09-10)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts`: `approval-last` now routes the question through `request_user_input` (wait_for_answer true/false, proceed on no answers, never for permission requests) instead of "One focused question, then end the turn". `failure-cap` asks that precise question through `request_user_input` when it is available. `pause-transparency` adds that a skill/project exception is not itself an approval request. `initiative-bias` finishes every unblocked part when one part is outside reach. No rules added; emphasis set unchanged (the three asynchronous-execution rules).
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-5.6.ts`: the narrow-question stop line names `request_user_input` when it is available.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-fable-5-1.ts`, `claude-opus-5.ts`, `claude-fable-5.ts`: the ask sentence names `ask_user_question` when it is available (`waitForAnswer` true when the next step depends on the answer).
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/kimi-k3.ts`: the unblock question goes through `ask_user_question` when it is available.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/glm-5.ts` (shared by `glm-5-2.ts` / `glm-5-3.ts`): the tuning paragraph asks through `ask_user_question` when only the user can settle a question.
- Tests: `packages/coding-agent/test/suite/prompt-presets-gpt-6-astra.test.ts`, `prompt-presets-gpt-5-6.test.ts`, `prompt-presets-claude-fable-5-1.test.ts`, `prompt-presets-claude-opus-5.test.ts`, `prompt-presets-claude-fable-5.test.ts`, `prompt-presets-kimi-k3.test.ts`, `prompt-presets-glm-5-2.test.ts`, `prompt-presets-glm-5-3.test.ts` pin the tool-name sentinels. Captured RED on the test-only commit, GREEN after these edits.

### Why

- Category C (missing context) per the prompt-engineering skill. The presets still told the model to end the turn or ask in prose after the builtin question tool landed, so a question that should be `request_user_input` / `ask_user_question` looked like a blocked goal or a bare stop. The new clauses keep the existing ask trigger and add the route, including `when it is available` so a session without the tool still reads.
- Token cost (o200k via gpt-tokenizer; eval, read, bash, monitor, task, todo, request_user_input, ask_user_question selected; empty snippets): gpt-6-astra 3491 -> 3586 (+95), gpt-5.6 2867 -> 2875 (+8), claude-fable-5-1 1654 -> 1676 (+22), claude-opus-5 1837 -> 1859 (+22), claude-fable-5 1690 -> 1713 (+23), kimi-k3 1901 -> 1910 (+9), glm-5.2/glm-5.3 1851 -> 1883 (+32). Astra overshoots the +60 growth gate because the four specified sentence edits land together; the other presets stay inside it. Rendered prompts with and without the question tools in `selectedTools` keep the same sentences.

### Why extension system couldn't handle this differently

- Content-only change inside builtin preset prose. The tool already exists; the models were not told to use it.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `gpt-6-astra.ts` APPROVAL_LAST / FAILURE_CAP / PAUSE_TRANSPARENCY / INITIATIVE_BIAS and the Claude/Kimi/GLM/gpt-5.6 ask sentences are edited often.

## Eval rules: batch what is independent, observe what is not (2026-09-09)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/execution-tooling.ts`: the shared Claude/Kimi rule set is now `eval-routing-decision` (independent reads, searches, symbol lookups, and probes go into one `eval` cell; edits, side-effecting commands, deploys, approvals, and result-dependent calls run one at a time, each observed before the next), `eval-evidence-return` (name the state a cell should produce, compare the returned evidence with it, check a mutating cell for changes beyond it; a result that hides a failed item or a truncated tail is not evidence), the new `perceived-state-loop` (a page, component, image, 3D scene, or layout gets one change, a render or screenshot, a look, then the next change; several angles for 3D, desktop and mobile widths for a page; compare with the reference or stated intent and ask only where two readings diverge), and the unchanged `eval-stay-direct`. `eval-default-surface` and `eval-real-code` are gone; cell mechanics (real code, per-item try/catch that keeps failures verbatim, truncation re-read) now live only in the eval tool description.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts` and `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-5.6.ts`: `eval-first-routing` is the same dependency decision in the Codex register (batch independent reads and inspect every result; keep edits, approvals, waits, and adaptive follow-ups sequential); `parallel-batching`, `over-call-bias`, and `in-kernel-reduction` are folded into it or replaced by `evidence-comparison` and `perceived-state-loop`. The two Astra eval rules lost their capitals and bold; only the three asynchronous-execution rules keep emphasis.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/kimi-k3.ts`: the Working the Task paragraph carries a worked loop ("open the definition, file, or command you are about to rely on; make the change; run or render it; compare the result with the state you named; stop when they match") and "a definition, command, or file you have not opened is not a fact" in place of the bare read-before-claim sentence.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-fable-5-1.ts` and `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-fable-5.ts`: the "extra read is cheap, a stale assumption costs the turn" clause is deleted from the core because the routing rule now carries it.
- Tests: `packages/coding-agent/test/suite/prompt-presets-execution-tooling.test.ts` (rule table, plus a no-shouting check on the Kimi dialect), `packages/coding-agent/test/suite/prompt-presets-gpt-6-astra.test.ts` (rule and placement tables; emphasis set is the three async rules), `packages/coding-agent/test/suite/prompt-presets-gpt-5-6.test.ts` (rule and placement tables). Captured RED on the test-only commit (rule-set equality), GREEN after the rule change.

### Why

- Category B (misframing) per the prompt-engineering skill. "One cell per multi-call step, never a chain" is a call-count law; the information law is that batching is safe for calls whose results text can verify and wrong for calls whose next step depends on inspecting a result. A census of 5,187 pi-family sessions (2026-09-09) found ~580 "assumed instead of observed" moments; the code-mode share matched its base rate, but the mechanism shifted to batches hiding their own evidence: cells with two or more mutating operations returning under 800 characters rose from 16.7% to 22.6% after the 2026-09-04 directive (fable-5.1 17 -> 24%, opus-5 23 -> 30%), 24% of blank or failed cells were followed by proceeding as if they had succeeded, 14% of aggregate-only cells hid a detail the next step needed, and a frontend edit was followed by a screenshot 24% of the time. The user's own Blender report (2026-09-09) is the same failure: a script built the whole model at once and nothing looked at it.
- Category C (missing context) for the visual loop: nothing told the model that a perceived result must be looked at after each change. Codex's Sol frontend guidance verifies with screenshots across viewports before finishing; Codex's Astra template batches independent reads, inspects every result, and keeps edits and adaptive follow-ups sequential - the same line this change draws.
- Per-model: Claude keeps a tagged block with a few key verbs; Kimi gets positive prose, a worked loop, and no capitals (Moonshot's remedy for K3's excessive proactiveness is concrete constraints, not emphasis); GPT drops the capitals the GPT-5.6 guide warns compound with generic instructions and gains the truncated-output re-read that dominated its true cases (9 of 18).
- Token cost (o200k, eval selected, 10 tools): fable-5-1 1735 -> 1754, fable-5 1771 -> 1790, opus-5 1898 -> 1937, opus-4-8 1984 -> 2055, gpt-6-astra 3509 -> 3557, gpt-5.6 2935 -> 2944, kimi-k3 1871 -> 2001, glm-5.3 1880 -> 1951; the eval tool description shrank 99-120 tokens for the Claude, Kimi, and default dialects, so a session nets negative for every family except Astra (+44, the new visual rule) and Kimi (+10, the worked loop).

### Why extension system couldn't handle this differently

- Content-only change inside builtin rule data and core templates.

### Expected merge conflict zones on next upstream sync

- LOW: all files are fork-only.

## GPT-6 Astra: do the work yourself, open a new request once, consult memory before asking (2026-09-08)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts`: `delegation` now leads with the keep-it default ("Do the work yourself by default: whatever closes in a handful of calls is yours, and a follow-up on work you delegated is yours to take back, not to forward") and names the only thing that earns a subagent (a sizeable track independent of your own); the brief contents (deliverable, edit scope, stop condition, evidence) are unchanged. `foreground-exception`'s child-task clause reads "when its result would be your next input, either the work was small enough to do yourself or the child runs in the background" instead of "spawn it in the background and let the completion deliver it". The Intent Gate opens "a new request" rather than "every turn ... before anything else", and `steering` says a mid-task message steers rather than opening a new request, so the reply opens with the work under the reading already declared. New `memory-first` rule (concern `initiative`, rendered in `## Initiative` after `approval-last`): consult memory before asking anything it may already answer, and take this user's preferences and working habits from it. The file header records the observed inversion behind the delegation change.
- `packages/coding-agent/test/suite/prompt-presets-gpt-6-astra.test.ts`: `memory-first` added to the concern and placement tables (captured RED on `aaf14cee8`: 1 failed | 33 passed, the rule-set equality at :254), plus a guard that the rendered `## Intent Gate` still carries the fork's `I read this as` sentinel that other suites and the README consume. Emphasis set unchanged.

### Why

- Category B (misframing) for delegation, per the prompt-engineering skill. The guide says Astra delegates less than a fan-out workflow wants, so the 2026-09-04 rule opened with "whenever running them beside your own work saves time or improves the result" and left "what you can close in a handful of calls, keep" as a trailer, while the 2026-09-05 async rules put "CHILD TASKS ... START IN THE BACKGROUND" in bold and `foreground-exception` ended on "spawn it in the background and let the completion deliver it". Under this fork's tools the observed behavior inverted: across 62 `~/.omo/agent/sessions` files from 2026-09-06..08 on the same tool surface, `task` + `task_send` were 39.4% of all tool calls for `opencodex/gpt-6-astra-fast` (3 sessions), 15.6% for `openai/gpt-6-astra`, 5.5% for `openai/gpt-6-astra-fast`, against 3.8% for claude-opus-4-8, 2.5% for claude-opus-5, 1.8% for claude-fable-5-1, and 1.6% for kimi-k3. The trace that triggered this change (session `01a07f74`, 2026-09-08): two consecutive `task_send` calls forwarding a one-`curl` token check and a one-key config change to a child it had spawned earlier, and when asked why, "bundling the log, KV, and request checks into one child seemed more efficient" - the efficiency trigger the rule itself supplied. The Claude and Kimi presets say "hand sizeable independent tracks to subagents ... keep work you can finish in a few calls yourself"; the Astra rule had dropped "sizeable" and inverted the order.
- Category A (wrong information) for the routing line. "Open every turn with one short routing line before anything else" contradicted `steering` ("fold in corrections and constraints ... and keep going") for every mid-task message, and Astra follows the literal instruction: in the same session it opened four consecutive replies, including one to a steering message and one to a complaint, with a Korean restatement of the ask and the stop condition, which the user experienced as over-clarifying ("과질문하면서 명료하게 하고자하는 성향"). The routing line itself is the fork-wide contract every preset carries and stays; its scope is now the new request, matching the omo `gpt-5-4` / `kimi-k2-7` sisyphus prompts ("do not restate this on later turns of the same request").
- Category C (missing context) for memory. `instruction-precedence` named memory only as something user instructions outrank; nothing routed the model to stored memory for this user's preferences before asking, and the user asked for exactly that ("메모리 적극 참조해서 사용자 성향 파악해서").
- Token cost (o200k, changed segments only): 193 -> 281, +88. `memory-first` is +41 of that; `steering` +25 (the why-clause that supersedes a fresh line), `delegation` +14, `foreground-exception` +10, the gate opener -2. A first draft measured +112 and was tightened once (dropped "worth the hand-off", merged `steering` into one sentence). Nothing outside the five segments and the file header changed.
- Not run: a live-model A/B. The 2026-09-05 backtest harness under `/tmp` is gone, bare senpi exposes no `task` tool (it comes from the omo-senpi plugin), and the codex backend was returning `server_is_overloaded` on 48-93% of Astra requests on 2026-09-08. The evidence for this change is the session survey above plus the rendered prompt.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin's rule data and core template.

### Expected merge conflict zones on next upstream sync

- LOW: `gpt-6-astra.ts` and its test are fork-only.

## GPT-6 Astra: the subscription rule names `tool.monitor` and the trigger (2026-09-05)

### What changed

- `gpt-6-astra.ts`: `monitor-conditions` no longer opens with "WHEN `monitor` IS AVAILABLE". It reads "EVERY CONDITION YOU WOULD OTHERWISE CHECK ON GETS A SUBSCRIPTION: `tool.monitor({ description, command, filter })` FROM THE EVAL CELL THAT STARTS THE RUN" (a direct `monitor` call only in a session without `eval`), lists the conditions (a build, install, or test run finishing; a CI check or PR turning green; a deploy landing; a log line; a file appearing; another session or machine changing state), says to arm the watch the moment the model's own work starts it *or the user names it, without being asked*, and states the cost once: the subscription is the whole cost of the wait and its matching line wakes you; a cell that awaits the wait holds the js kernel until the cell limit kills it. The steer/read/stop-through-session-tools sentence is unchanged. `async-default` now names the form a wait takes - "A WAIT IS A `tool.monitor` SUBSCRIPTION - NEVER A CELL THAT SITS ON A `--watch` OR A SPAWNED PROCESS, NEVER A CHILD SPAWNED TO WATCH" - next to the three forms it already listed, and "a long eval cell detaches" becomes "a long computation detaches its eval cell". The file header records why the rule names the form and the trigger.
- `test/suite/prompt-presets-gpt-6-astra.test.ts`: one sentinel - the rendered `## Asynchronous Work` section contains `tool.monitor(` - captured RED on `7c1de741e` and GREEN after the edit. Rule ids, concerns, placement, and the emphasis set are unchanged.

### Why

- Category A per the prompt-engineering skill: since 2026-09-03 `bash` and `monitor` leave the model's direct tool list whenever the session has `eval` (terminal `prompt.ts` renders `tool.monitor(...)` shapes for that branch). A rule conditioned on `monitor` being available therefore evaluated false in every eval session - the only sessions omo runs - and the model behaved as if it had no subscription primitive.
- Evidence, 17 `gpt-6-astra-fast` sessions of 2026-09-05 (`~/.omo/agent/sessions`): `tool.monitor` appeared in three sessions, each one whose request itself named the CI run or the async work; one orchestrator session polled `task_output` 35 times (status every ~40 s on the same child) and another blocked inside eval cells on `Bun.spawn` + `setTimeout(kill, 580-880 s)` for installs, builds, and test runs. A sandboxed backtest against the real model in the eval-only tool shape (no direct `bash`/`monitor`, real eval description and terminal section, omo task tool, effort high; `/tmp/ulw-astra-monitor/monitor-run.ts`) reproduced it before the edit: 0 of 12 valid first responses across three wait-shaped requests (a 12-minute test run with parallel reading, a CI-then-merge request, and a "CI is running on my push, meanwhile inspect this file" request) registered a subscription - the model read files, opened a todo list, or started the long command with `tool.bash({ run_in_background: true })` and no filter.
- Category B for `async-default`: it listed background bash, a detached cell, and a background child as equally good asynchronous forms and said nothing about which form a *wait* takes, so once plain polling was ruled out the model awaited `gh pr checks --watch` through `Bun.spawn` inside a cell (2 of 3 multi-round samples on a CI-then-merge request; the cell detaches, which the rule sanctioned) or spawned a `quick` child whose whole brief was "monitor PR #7801 until green, then merge" - the child is a model session polling on its behalf. The wait form is now named in the same sentence as the other forms.
- Category C for the trigger: the old list named only waits the model had started itself, so state the user mentioned (a CI run on their push) never became a watch. The GPT-5.6 guide's tool-routing rule applies - name the route when it is not obvious; generic "use it efficiently" wording does not produce it - and its decision-rule preference over absolute wording: "every condition you would otherwise check on" is the decision rule, and the bold/caps emphasis on this rule stays by the owner's standing direction.
- Token cost (o200k, eval-only shape with the terminal section, same tool set): rendered prompt 4392 -> 4565; the async section 289 -> 451 carries the call form, the no-`eval` fallback, the trigger list, the wait-form clause in `async-default`, the in-scope clause for user-named state, and the one-sentence cost; the availability gate and the old four-item list were removed to pay for part of it. Nothing outside the two rules changed.
- Real-model result (multi-round harness, effort high, 3 samples per cell, old = 7c1de741e preset, new = this change plus the senpi-codemode GPT dialect fix): a 12-minute test run with parallel reading 0/3 -> 3/3 `tool.monitor`; CI-then-merge 1/3 -> 3/3; "CI is running on my push, meanwhile inspect this file" 0/3 -> 2/3, the new samples arming `gh run watch <id> --exit-status` next to the read. With the ultrawork directive attached (2 samples per cell): CI-then-merge 0/2 -> 2/2. Evidence: `/tmp/ulw-astra-monitor/evidence/mr{3,4,5}-*/<request>/summary.json` on mengmotaHost.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin's rule data.

### Expected merge conflict zones on next upstream sync

- LOW: `gpt-6-astra.ts` and its test are fork-only.

## GPT-6 Astra: asynchronous is the default form of every call (2026-09-05)

### What changed

- `gpt-6-astra.ts`: `async-handles` becomes `async-default` ("asynchronous is the default form of every call that offers one: child tasks and bash sessions start in the background, and a long eval cell detaches"), and a new plain rule `foreground-exception` names the only two cases for blocking (a call that finishes within a reply and decides the very next call, or an approval-gated/destructive action watched directly) and states that a child task never meets the first test even when its result is the next input. `turn-end-is-wait` gains "and the task continues"; the Intent Gate stop line and the Stop Goal say the *task* is over, not the *turn*. `delegation` now names the form (spawn together, in the background) and adopts the Astra guide's decision rule (whenever running tracks beside your own work saves time or improves the result). The `Gpt6AstraRuleId` union and `GPT6_ASTRA_RULES` follow; the file header records the async section's design.
- `test/suite/prompt-presets-gpt-6-astra.test.ts`: concern/placement tables carry the two async ids; the async-work concern is pinned to exactly `async-default`, `foreground-exception`, `turn-end-is-wait`, `monitor-conditions` in that order; the emphasis set swaps `async-handles` for `async-default` (the exception rule stays plain).

### Why

- Live backtest against the real `gpt-6-astra` (senpi openai-codex path, rendered through `resolvePreset`, omo's `task` tool attached): with the shipped preset the model spawned a single dependent child with `run_in_background: false` (3/3 samples) or omitted (3/3) and blocked on it, reasoning "I'll have the deep agent investigate ... then I'll run the tests". Diagnosis per the prompt-engineering skill: `RUN LONG WORK ASYNCHRONOUSLY` made async conditional on the model's own reading of "long", so a child whose result is the next input read as "needed now" (misframing); `delegation` said "send them together" without saying where children run (unsatisfiable under a blocking default); and the Stop Goal's "the turn is over the moment all of these hold" contradicted `END YOUR TURN; THE COMPLETION WAKES YOU", which an instruction-follower resolves by never ending the turn. Each defect is fixed at its source; nothing was appended on top.
- Token cost (o200k, same tool set and omo task guidelines in both renders): 3779 -> 3854 (+75), all of it the exception rule (+~55) and the turn/task fix (+5); "never assume or invent what it will contain" left the async rule because Hard Limits already forbid presenting a pending result as fact.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin's rule data.

### Expected merge conflict zones on next upstream sync

- LOW: `gpt-6-astra.ts` and its test are fork-only.

## GPT-6 Astra preset, written from scratch (2026-09-04)

### What changed

- `gpt-6-astra.ts`: new full-core preset (`corePrompt` override, `workstationDialect: "codex"`, shared `buildTestDisciplineSection()` + `buildGptEvalRoutingTuning()` + `buildFileOperationsTuning()`). Sections: Intent Gate, Initiative, Instructions From Files, Working the Task, Asynchronous Work, Verification, Scope and Recovery, Hard Limits, Writing, Reporting, Stop Goal. 28 directives live in `GPT6_ASTRA_RULES` (typed rule data, ids -> concerns) and render exactly once each at their point of use.
- `presets.ts`: `hasGpt6AstraSignal` / `isGpt6AstraModel` (regex `gpt[._-]?6[._-]astra` with `[/@:._-]` boundaries on id or display name), checked before the GPT-5.x version extractor; `resolvePresetName` branch + `buildPreset` case. Bare `gpt-6` and bare `astra` deliberately do not match.
- `settings.ts`: `"gpt-6-astra"` joins `PromptPresetName` and `VALID_PRESETS`; `docs/settings.md`, `AGENTS.md`, `builtin/AGENTS.md` list it.
- `gpt-eval-routing.ts`: the shared GPT bridge dropped its `exec`/`wait` clause. Those Code Mode tools were removed in commit 6bea3a3b4 (`registerRemovedToolHint` in senpi-codemode proves models still reached for them), so the bridge was category-A wrong information for every GPT preset; it now names `eval` only. `prompt-presets-gpt-eval-routing.test.ts` stops registering the removed tools, covers `gpt-6-astra`, and asserts the bridge names no removed tool.
- `test/suite/prompt-presets-gpt-6-astra.test.ts`: id-shape resolution (bare, `-fast`, dated snapshot, openrouter `openai/`, Bedrock `openai.` and `global.openai.`, `azure/`, display name, underscore id), non-routing of `gpt-5.6-sol` / `gpt-5.6-astra` / `gpt-6` / `gpt-6-mini` / `gpt-6.1` / `astral-v1` / `astra`, distinctness from gpt-5.6, settings force, catalog sweep, rule-data placement table, once-only rendering, emphasis restricted to the eval-cell and async rules, no emoji, and two-way isolation from the GPT-5.6 / GPT-5.5 contracts.
- `.agents/skills/senpi-qa/scripts/gpt-6-astra-preset-mock-loop.mjs`: Channel 3 proof that the preset reaches the wire (fake OpenAI Responses server, `--print --provider openai --model gpt-6-astra`, asserts the developer message carries the Astra-only sections and none of the GPT-5.6-only ones). Runs under bun.

### Why, section by section (GPT-6 Astra guide, developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra, read 2026-09-04)

- Written from scratch instead of adapting `gpt-5.6.ts`: the guide describes Astra as more capable than 5.6 Sol but with five behavior shifts, and the GPT-5.6 guide's simplify-first doctrine still applies (minimal prompts beat process-heavy ones in OpenAI's evals). Reusing the 5.6 text would have carried its 5.6-specific framing (the Hephaestus "Implement, don't propose" voice, three restatements of the stop contract) into a model that mirrors prompt phrasing.
- Identity + Intent Gate: the fork's binding declared-stop-condition contract (per-turn routing line) is kept because Astra "persists" and "stays coherent during long tasks" - the same over-run risk the 5.6 guide's mandatory stop rules address. The three intent families (information / judgment / change) are stated once; the guide's "can you", "help me", "I want to" phrasing joins the change family because the guide names those exact surface forms as ones Astra may answer with capability instead of work.
- Initiative (guide: "Initiative and follow-through"): Astra "is more likely to ask for clarification where earlier models would make assumptions" and "likes to ask non-blocking questions". The section carries the guide's remedies in this fork's words: bias to action with routine gaps filled from context, persistence through failures and long turns, authorization persisting across the session, and approval only as the last step on a concrete reviewable result (the guide's deploy / external write / merge / publish example). "No unsolicited warnings, disclaimers, approval flows, or safety/compliance checklists due to hypothetical risk" is the guide's own sentence, kept because Astra's alignment training makes it the likeliest new failure. Steering semantics (fold in corrections, answer status in a sentence, drop only on cancel or incompatible objective) match senpi's steer/follow-up queues and Astra's documented strength at incorporating new requirements mid-task.
- Instructions From Files (guide: "Instruction following"): Astra "can be more sensitive to instructions contained in skills and other files, such as AGENTS.md" and "unclear or conflicting guidance in a skill file may cause the model to pause and block work early". The guide prescribes two prompts - user precedence over skills, and naming/quoting the SKILL.md line that caused a pause, distinguishing explicit requirements from interpretation - both rendered here as one rule each. senpi's skills section and project-context section render after the core, so this is the only place the precedence order is stated.
- Working the Task: eval-first orchestration is this fork's standing execution discipline and, for Astra, matches the model's own prior - codex's Astra template runs `tool_mode: code_mode_only` with `functions.exec` batching independent calls through `Promise.allSettled`. Per the owner's direction the eval-cell rule and the parallel fan-out rule are the only orchestration text rendered in capitals and bold; over-call bias, in-kernel reduction, the stay-direct exceptions, and the new `bun-runtime` rule (read the bun-1-4 skill the eval tool names before the first js cell; Bun builtins before dependencies) stay plain. Delegation is explicit because the guide says Astra "may delegate less often than desired" and recommends telling it when to parallelize through collaboration tools; the legibility rule ("proper spaces between words and/or numbers") is the guide's own observation about inter-agent messages. LSP symbol routing and finest-grain todo transitions are fork standing orders Astra cannot derive.
- Asynchronous Work: Astra is trained on async tool calling (a `function_call` with `async: true` returns on its original `call_id` later, optionally gated by an app-defined `wait_for_tasks` tool; OpenAI's own example instructs "never invent" the pending result). senpi has no `async: true` wire support and no wait tool: long work runs as PTY bash sessions that auto-detach, detached eval cells, `monitor` subscriptions, and background `task` children whose completions arrive as injected messages when the turn ends or at the next tool boundary. The section maps the trained model onto that: a handle is a pending async call, keep working, never invent the result, end the turn to wait, one peek only for a midpoint decision, and `monitor` for every observable condition. Rendered in bold/caps by owner direction (async execution and monitor use are enforced, not suggested).
- Verification (guide: "Testing and verification"): Astra "tends to be thorough in testing" and "for smaller tasks this can result in broader tests than the task requires". The fork's tiered scope stays; the guide's calibration ("run tests appropriate to the change ... broaden or repeat testing only when new changes, failures, or unresolved concerns justify it") is rendered as `verification-once`, deduplicated against the shared single-pass-runner rule. Test-first stays a fork order but is scoped to one failing test at the touched seam, and the guide's "do not write tests ... that mirror the implementation" is folded into the same rule so the two never conflict.
- Scope and Recovery: smallest-correct-change, boundary-only validation, no speculative shims, and the three-materially-different-attempts cap are the fork's contracts (also in 5.6), stated once each.
- Hard Limits: commit/destructive-git rules, shared-workspace rule, never-suppress, never-invent, plus codex's "do not use tools to send messages to others unless explicit authorization is already provided" - adopted because senpi ships chat, email, and issue-comment tools through skills and an autonomous Astra with persistent authorization must not post on its own.
- Writing (guide: "Personality and writing style"): Astra "tends toward detailed, formatted responses and may use recurring phrases". The section asks for the prose a careful engineer writes to a colleague (plain words, exact paths/commands/numbers, connected paragraphs, point first, lists only for parallel items, headings only for long multi-part replies), bans the guide's slop list verbatim ("delve", "leverage", "foster", "it's worth noting", "importantly", "genuinely", "Bottom line:", "In short:", "Question? Answer.", "this isn't about X, it's about Y", hyphen-chained descriptors, invented compound labels, canned transitions), and adopts the guide's "state the intended action directly ... avoid contrastive framing" as `direct-statements`. Because Astra mirrors prompt phrasing, the preset itself avoids "X, not Y" constructions and uses "genuinely" nowhere outside the ban list. The fork's tone rules (opinion, no flattery, user's language, no refusals) are stated once.
- Reporting: progress updates only at plan changes (the 5.6 guide's sparse-update rule; codex's 60-second commentary cadence is a commentary-channel feature senpi lacks); final message = outcome, then evidence ordered for checking rather than chronology (guide: "Present reasoning and evidence in the order that makes the conclusion easiest to assess"); preserve-first when shrinking (5.6 guide: replace brevity with prioritization); review shape; terminal-safe references (`src/auth.ts:42`, fenced code, ASCII, no emoji) instead of codex's clickable-link syntax, which the TUI cannot render; commit messages and PR descriptions described for a reviewer who never saw the conversation (codex's PR-description guidance, kept because it is a real behavior delta).
- Stop Goal: the four-part stop contract in its shortest form (observable completion, tier checks clean or explained, final message delivered; stop immediately; compaction is automatic so context limits never end a task). The per-result stop check lives in the eval-cell rules; the failure cap in Scope and Recovery.
- Left out of codex's Astra template, each for a reason: the `commentary`/`final` channel mechanics and 60-second cadence (senpi streams one assistant message), clickable file-link syntax and visualization guidance (terminal renderer), Apps/Plugins/notes/history tools (not senpi surfaces), the multi-agent role prompts (senpi's `task`/team tools carry their own contracts), and the GPT-5.6 Sol template's "old friend" personality block (persona prose with no behavioral consequence, the same reason senpi's 5.6 preset never adopted it).

### Token evidence (o200k via gpt-tokenizer; eval, monitor, grep, glob, read, bash, task, todo selected; empty snippets)

- gpt-6-astra 3047 tokens (14,427 chars) vs gpt-5.6 2867 (after the bridge fix; 2969 before). Per section: identity 40, Intent Gate 191, Initiative 264, Instructions From Files 92, Working the Task ~570, Asynchronous Work ~212, Verification ~400, Scope and Recovery 155, Hard Limits ~190, Writing ~320, Reporting 228, Stop Goal ~120.
- The +180 over 5.6 is the two sections 5.6 has no counterpart for (Instructions From Files + Asynchronous Work, ~300 tokens, both guide- or harness-mandated) plus the owner-directed bun-runtime rule; every other section was cut against its first draft (Initiative -60, orchestration rules -120, Verification -45, Stop Goal -20, one process line and a duplicated compaction clause removed, the run-once rule merged with the shared single-pass-runner rule). Excluding the two new sections the core is ~2740 tokens, under the 5.6 core.

### Decisions recorded

- `high-reasoning-warning.ts` is intentionally NOT extended to gpt-6-astra (the catalog PR #1334 deferred this). That warning guards the gpt-5.x Sol over-run failure; the Astra guide describes Astra as "our most aligned model yet" that "excels at exercising care, respecting task boundaries", the opposite failure mode, so no warning is warranted. The residual from #1334 is closed by this note, not by a code change.
- `brand-identity.test.ts` gains gpt-6-astra in its `PRESET_FILES` / `PRESET_BUILDERS` sweep (the guard that no full-core preset hardcodes the product name), following the claude-fable-5-1 precedent.

### Why extension system couldn't handle this differently

- Content-only addition inside this builtin, following the established `corePrompt` preset architecture; the bridge fix is a one-line correction of shared tuning text.

### Known follow-up (out of scope here)

- `file-operations.ts` names `apply_patch` / `read` / `grep` unconditionally, and every GPT preset appends it unconditionally (documented convention in this folder's AGENTS.md). Making that block derive its tool names from the active tool set is a cross-cutting change across all GPT presets and their tests, tracked separately rather than bundled into this preset.

### Expected merge conflict zones on next upstream sync

- LOW: `gpt-6-astra.ts` is fork-only; `presets.ts` / `settings.ts` touch shared lists (adjacent-line conflicts only if upstream adds presets); `gpt-eval-routing.ts` is fork-only.

## Wait-as-subscription stance moves to the eval tool description (2026-09-03)

### What changed

- `execution-tooling.ts`: the `monitor-subscribe` rule, the `async-waiting` concern, and the exported `CODEX_MONITOR_SUBSCRIBE_DIRECTIVE` are deleted. `ExecutionToolingRuleId` keeps the three `code-cell-routing` ids, `ExecutionToolingConcern` narrows to that single concern, `ExecutionToolingRule.directive` drops its optional `codex` member, and `CONCERN_TOOL` maps the one remaining concern to `eval`.
- `gpt-5.6.ts`: the `monitor-subscribe` entry leaves `GPT56_EXECUTION_RULES`, `buildCodexMonitorClause()` is deleted along with its interpolation in the Tool-orchestration paragraph, and `"monitor-subscribe"` leaves the `Gpt56ExecutionRuleId` union.
- `test/suite/prompt-presets-execution-tooling.test.ts` and `test/suite/prompt-presets-gpt-5-6.test.ts`: the deleted rule leaves the concern/placement tables, the gating cases assert eval alone, and each file gains a case pinning that the stance is absent here.

### Why

- `monitor` is now withheld from the model's direct tool list whenever the session has an `eval` tool. Both surfaces gated this rule on `monitor` being a *selected* tool, so the anti-polling stance would silently stop rendering in every eval session — exactly the regression the gating contract was written to prevent. Only the eval tool description can teach the `tool.monitor(...)` form the model must actually type, so the stance moves there and is stated once.

### Why an extension could not handle it

- Content-only change inside this builtin's own rule data; the presets are fork-only surfaces.

### Expected merge conflict zones

- LOW: both touched files are fork-only presets, and the change is a deletion.

## Kimi K3 core redesign for excessive proactiveness (2026-09-03)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/kimi-k3.ts`: the core is rebuilt on the Fable 5.1 skeleton (Intent Gate / Scope / Working the Task / Verification / Hard Limits / Style). New homes: a Scope section (the request is the deliverable; a pre-existing bug, performance concern, or unmentioned behavior is a follow-up for the summary unless the requested behavior cannot work without it; a blocked part means finishing every other part and naming what was left out; scratch checks are discarded and tests are committed only where the task asks or the repository keeps tests for that kind of change), a reflect-then-ask ambiguity gate that first does every part not depending on the answer, a bounded failure cap (three materially different attempts, then restore in-flight edits and ask one precise question), one delegation sentence with a propagated stop condition, and evidence-backed reporting. Two anchor phrases are bold: `deliver all of it and only it` and `An invented assumption is a defect.`
- Deleted as duplicates: the "never speculate" hard limit (the re-read rule owns it), the closing stop-condition restatement and the enumerated past-stop defects, the re-litigation sentence (the confirmation-turn rule owns it), the V1/V2/V3 labels, the quoted filler anti-examples, the "Read wide" sentence (the execution-tooling paragraph owns breadth when `eval` is selected), and Claude-default style traits. The act-bias rule that appeared in four places ("decisive" identity, decide-and-act, act-then-report / do-the-next-step / no-permission-begging, the closing keep-working line) now appears once, scoped to "reversible steps the request already covers".
- Every fork contract is preserved: README routing line (confirmation turns included), binding declared stop condition, `buildExecutionToolingParagraph` in the kimi dialect, `buildTestDisciplineSection()`, non-refusal, auto-compaction continuation, `workstationDialect: "kimi"`. Measured with the Kimi K3 tokenizer (HF `moonshotai/Kimi-K3` `tiktoken.model`): 1894 -> 1883 tokens for the full render with eval/monitor/grep/glob selected, 1608 -> 1597 bare.
- `AGENTS.md`: the K3 FILES row and the `corePrompt` exception paragraph describe the new rationale.

### Why

- The previous core was written through the K2.6 lens (kimi.md practitioner overlay: an overthinker that needs act-bias and terminal conditions and must not see prohibitions). Moonshot's own K3 release notes (technical blog, Limitations) describe the opposite failure - "excessive proactiveness": on minor issues or ambiguous user intent K3 "may make unexpected decisions on the user's behalf", and the recommended remedy is "more explicit behavioral constraints in the system prompt or AGENTS.md". Four act-bias statements against one reflect-then-ask clause let the trained prior win; the 2026-08-03 corpus (K3 writing more test files than any other model) is the same failure on the test axis.
- The Fable 5.1 guide's Delivering-work and changes-and-tests blocks are the documented cure for exactly this behavior on Claude (unrequested additions and committed test code drop with no change in task success); the GPT-5.6 guide's bounded failure cap converts the "minor issue" trigger into a decision with a terminal condition. Both are stated once, in positive DO-framing per the Kimi first-party prompt guide, without all-caps prohibitions.
- Prompt-growth defense: the additions are paid for by the duplicate deletions above; the rendered prompt is 11 tokens shorter than before.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin's K3 core via the builder's existing `corePrompt` override; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- NONE expected: `kimi-k3.ts` and this tracker are fork-only files.

## Opus 4.x / Opus 5 / GLM 5.x preset parity with the dieted cores (2026-09-03)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-opus-5.ts`: rebuilt on the claude-fable-5-1 skeleton (one home per rule, a `## Scope` section, literal register). The 2026-07-24 core stated the stop contract three times in one paragraph, scope twice, kept quoted anti-example scaffolding, a default-trait list, and a Hard Limit the claim-audit rule already covers; it lacked the Opus 5 guide's outcome-first final-summary shape and the 5.1 blocks (test scope, pre-existing bug as follow-up, blocked-part handling, ask after answer-independent work, surgical edits, claim audit). Every Opus 5 guide behavior is kept once where it binds: bounded single-pass verification, delegation caps fused with keep-working-while-they-run, narration cadence, correction filter, document length, the guide's short conciseness line. Rendered prompt (eval+monitor+task selected): 1,877 -> 1,984 o200k tokens; the growth is the missing documented behaviors, the repetition is gone.
- `claude-opus-4-8.ts` / `claude-opus-4-7.ts`: tuning keeps only the guide-documented deltas the dieted core lacks (literal scope, tool-over-reasoning, house-style counter) and adds the guide's same-turn subagent fan-out direction (the guide: both models spawn fewer subagents by default and are steerable). 4.8 keeps its interactive-turn delta reduced to the non-duplicate half ("reason over what changed"). The compaction-continuation line and the "do not re-derive facts" clause are dropped: the core now carries both.
- `claude-opus-4-6.ts`: tuning text removed entirely. Its three lines were the one-plan rule (now core Working the Task), scope literalism (documented for 4.7+, not 4.6), and compaction continuation (now core Style with the mechanism). claude.md documents nothing further for 4.6 that the dieted core lacks, so the preset renders the execution-tooling stance and the claude workstation dialect only. Rendered: 1,945 -> 1,916 tokens.
- `claude-opus-4-5.ts`: compaction line dropped (same reason); the 4.5 ordered-steps tuning is unchanged.
- `glm-5.ts` (new) + `glm-5-2.ts` / `glm-5-3.ts`: one shared builder. Removed from the old identical tunings: the lineage preamble ("Opus 4.6-class ... Fable 5 decisiveness ... GPT 5.5 outcome-first" - a model claim with no behavioral consequence), "the routing line is non-optional" (duplicates the Intent Gate), the "ultrawork mode" sentence (a mode the prompt never defines; omo's directive carries its own rules), the unconditional `todo` procedure (names a tool the turn may not have; the tool section carries it when present), "define the outcome ... stopping condition" and "prove completion with evidence" (Intent Gate / Verification). Added: the execution-tooling stance in the claude dialect (GLM is Claude-distilled; it was the only Claude-dialect preset without eval/monitor routing) and `GLM5_TUNING` - two sentences: tool call over deliberation, short act-inspect-verify loops (GLM-5 paper: strongest on repo exploration, weakest on long chained tasks where errors compound). 5.2 and 5.3 render identically: same base model, post-training delta only, no prompt-level guidance distinguishing them. Rendered: 1,776 -> 1,966 tokens, all of it the execution-tooling block.
- `packages/coding-agent/test/suite/prompt-presets-execution-tooling.test.ts`: glm-5.2/glm-5.3 join `PRESET_DIALECT` (claude); OUT_OF_SCOPE keeps gpt-5.5/grok-4.6/deepseek-v4-flash. `prompt-presets-glm-5-2.test.ts` / `-5-3`: prose pins ("running on GLM", "absolute certainty", "todo") replaced by shipped-copy containment of `GLM5_TUNING`. `prompt-presets-model-switch.test.ts`: the 4.6 switch asserts the 4.7 literalism sentinel is absent instead of pinning removed 4.6 prose.
- `AGENTS.md`: file table, WHERE TO LOOK, and conventions updated (documented-delta rule, no restating the dieted core).

### Why

- Prompt-engineering audit of every preset against the per-model guides (claude.md, Opus 4.7/4.8, Opus 5 at platform.claude.com, Fable 5/5.1, GPT-5.6, Kimi, Z.ai GLM-5/5.3 docs + the GLM-5 paper) after the universal core diet (#1302) moved the shared contracts into the core. Thin tunings that predated that diet now restated core rules (attention competition, no behavior gain); GLM carried undefined references and a tool name the turn may lack; the Opus 5 core repeated the very rule the guide says compounds with the model's own over-verification and lacked the guide's final-summary contract. The two core additions (conditional delegation, compaction mechanism - see `dynamic-prompt/changes.md`) give those behaviors one home so every thin preset drops its copy.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin plus two sentences in the core builder it wraps.

### Expected merge conflict zones on next upstream sync

- LOW: all preset files are fork-only; `glm-5.ts` is new.
## Execution tooling stance: eval-default + monitor subscription (2026-09-02)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/execution-tooling.ts`: new shared rule data `EXECUTION_TOOLING_RULES` (ids `eval-default-surface`, `eval-real-code`, `eval-stay-direct` under `code-cell-routing`; `monitor-subscribe` under `async-waiting`) with a claude dialect (tagged `<execution_tooling>` block, uppercase key verbs) and a kimi dialect (bold DO-framing, terminal conditions, no all-caps NEVER), plus the codex wording of the monitor rule. `buildExecutionToolingSection` renders the eval rules only when `eval` is a selected tool and the monitor rule only when `monitor` is, so no preset names a tool the session lacks.
- Claude cores (`claude-fable-5-1.ts`, `claude-fable-5.ts`, `claude-opus-5.ts`) and `kimi-k3.ts` render it inside Working the Task after the batching paragraph; Opus 4.5-4.8 and Kimi K2.6/K2.7 prepend it to their tuning section; `gpt-5.6.ts` adds `monitor-subscribe` to `GPT56_EXECUTION_RULES` at the orchestration point of use (its eval stance was already maximal).
- `test/suite/prompt-presets-execution-tooling.test.ts`: rule-data shape, exactly-once rendering per preset/dialect, eval/monitor gating, out-of-scope presets untouched. `prompt-presets-gpt-5-6.test.ts` expects the new rule.

### Why

- The eval tool description teaches cell mechanics and the terminal prompt documents monitor, but neither makes the routing decision: models still default to serial or native-parallel tool calls and to sleep/poll waits. The owner's standing workflow (one code cell per multi-call step with real control flow and maximal parallel batching; every wait as a monitor subscription) needs a system-prompt stance, written per family per the prompt-engineering references.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin; the rule-data module follows the `verification.ts` / `GPT56_EXECUTION_RULES` pattern.

### Expected merge conflict zones on next upstream sync

- LOW: all touched files are fork-only presets; `execution-tooling.ts` is new.

## Mythos routing + Fable 5.1 preset diet (2026-09-02)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/presets.ts`: `CLAUDE_FABLE_51_MARKERS`/`CLAUDE_FABLE_5_MARKERS` gain `mythos-5-1`/`mythos-5.1` and `mythos-5`, so Claude Mythos ids resolve to the matching Fable preset; the 5.1 marker set still resolves before the generic 5 set.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/claude-fable-5-1.ts`: dieted full-core rewrite. Duplicated rules (scope, stop contract, evidence audit, user's-call-final) stated once each; new `## Scope` section carries the 5.1 "Delivering work" + "changes and tests" blocks with the Fable 5 anti-over-engineering rule; model-default style traits and rationale flourishes removed; Fable 5 delegation guidance and the 5.1 ask-after-independent-work clause added. Rendered static core ~8.1k -> ~6.7k chars (-16.5%) through the real builder.
- `packages/coding-agent/test/suite/prompt-presets-claude-fable-5-1.test.ts` / `prompt-presets-claude-fable-5.test.ts`: mythos id-shape cases (5.1-before-5 precedence both ways) and a TEST_DISCIPLINE_RULES sweep on the 5.1 preset.

### Why

- Anthropic publishes one prompting guide per Fable/Mythos release pair; Mythos ids previously fell through to the default dynamic prompt. The 5.1 preset carried rules two or three times and restated model-default behavior, which costs attention and tokens on every turn.

### Why extension system couldn't handle this differently

- Content-only change inside this builtin; follows the established corePrompt preset architecture.

### Expected merge conflict zones on next upstream sync

- LOW: `claude-fable-5-1.ts` is fork-only; `presets.ts` matcher block may conflict trivially if upstream adds presets.

## Claude Fable 5.1 preset (2026-09-02)

### What changed

- `claude-fable-5-1.ts`: new full-core preset. Baseline is the dieted claude-fable-5 core (the Fable 5.1 guide states existing Fable 5 prompts carry over), plus surgical deltas mapped 1:1 to documented 5.1 behavior differences: scope-is-the-deliverable paragraph in the intent gate, per-response independent-call batching framing, surgical-edit-over-rewrite line, follow-up/test-scope sentences in Verification, bidirectional formatting rule replacing bullets-suppression, literal-phrase (anti-mannered-prose) clause, and progress-note encouragement replacing the shorthand permission.
- `presets.ts`: `isClaudeFable51Model` matcher (fable-5-1 / fable-5.1), checked before the generic `fable-5` substring so the dotted release is not swallowed; `resolvePresetName` branch + `buildPreset` case.
- `settings.ts`: `"claude-fable-5-1"` joins `PromptPresetName` and `VALID_PRESETS`.
- `docs/settings.md`: preset value list gains `claude-fable-5-1`.
- `test/suite/prompt-presets-claude-fable-5-1.test.ts`: id-shape resolution, fable-5/fable-5-1 precedence both ways, settings force. `prompt-presets-claude-fable-5.test.ts` catalog signal now excludes the 5.1 release; `brand-identity.test.ts` covers the new preset file.

### Why

- Claude Fable 5.1 shipped in the anthropic/bedrock/openrouter/vercel catalogs; without a matcher the generic fable-5 substring routed it to the Fable 5 preset, and the 5.1 guide documents behavior deltas that preset does not address.

### Why extension system couldn't handle this differently

- Content-only addition inside this builtin; follows the established corePrompt preset architecture.

### Expected merge conflict zones on next upstream sync

- LOW: `claude-fable-5-1.ts` is fork-only; `presets.ts`/`settings.ts` touch shared lists — trivial adjacent-line conflicts if upstream adds presets.

## Grok 4.6 preset (2026-08-17)

### What changed

- `grok-4.6.ts`: new full-core preset (builder `corePrompt` override, precedent: kimi-k3.ts / gpt-5.6.ts). Direct-implementer posture — NOT a clone of the grok-4.5 CEO/orchestrator preset. Tuned per the Grok 4.6 launch field guide (Eric Zakariasson, 2026-08-12): binding declared-stop-condition contract in the routing line (the guide's core finding — define what done means or the model decides), no intensity/exhortation language (measured as a no-op on this model), a real-surface verification loop as the highest-leverage rule (walk the user paths the change touches; for hard-to-inspect output: capture current state → list what is wrong → fix only those), a shared-piece rule against its observed repeated-block habit, and information-dense reporting (dense summaries, quiet through small changes, one short update at meaningful phase changes). Reuses `buildTestDisciplineSection()`; no `buildFileOperationsTuning()` because `apply_patch` is gated to gpt-* ids and never activates on Grok.
- `presets.ts`: `hasGrok46Signal`/`isGrok46Model` matcher (the 4.5 regex with a 4.6 minor version), checked before the 4.5 matcher; `resolvePresetName` branch + `buildPreset` case.
- `settings.ts`: `"grok-4.6"` joins `PromptPresetName` and `VALID_PRESETS`.
- `docs/settings.md`: preset value list gains `grok-4.5` (was missing) and `grok-4.6`.
- `test/suite/prompt-presets-grok-4-6.test.ts`: id-shape resolution, non-routing of 4.5/4.3/4.20/3/build/4.60, 4.5-vs-4.6 distinctness, settings force, and a catalog sweep asserting every built-in Grok 4.6 entry (xai, opencode, openrouter, vercel-ai-gateway) resolves.

### Why

- Grok 4.6 shipped in four built-in catalogs with no preset, falling back to the untuned dynamic prompt; the 4.5 matcher deliberately excludes it. The 4.5 CEO posture is a fork experiment specific to that model; 4.6 is positioned (and field-tested) as an all-round daily driver, so it gets an implementer core.

### Why extension system couldn't handle this differently

- Content-only addition inside this builtin; follows the established corePrompt preset architecture.

### Expected merge conflict zones on next upstream sync

- LOW: `grok-4.6.ts` is fork-only; `presets.ts`/`settings.ts` touch shared lists — trivial adjacent-line conflicts if upstream adds presets.

## Presets yield to user system-prompt overrides (2026-08-17)

### What changed

- `index.ts`: `before_agent_start` returns no replacement when `event.systemPromptOptions.customPrompt` is set (a `--system-prompt` / SDK loader override) — the base prompt already carries the user's prompt plus appends. When only `appendSystemPrompt` is set, the preset still replaces the base but reappends the user text (`preset + "\n\n" + appends`), so appends survive preset replacement.
- `model_select` applies the same policy: custom prompt present returns `{ systemPrompt: null }` (reset to the user-carrying base); otherwise the preset prompt gets the user appends reattached.
- The startup header (`getPresetName`) reports no preset when a custom prompt is active, via the new `ctx.getSystemPromptOptions()` base-context getter.
- `agent-session.ts` populates `customPrompt` / `appendSystemPrompt` (pre-joined) into `_baseSystemPromptOptions`, which flows into both events and the context getter.

### Why

- Before this, a preset-matching model silently discarded explicit user overrides: the preset replaced the entire base prompt (including `--append-system-prompt` text) on every turn. That made the documented flags unusable on gpt-5.x/claude/kimi/glm/deepseek/grok models and forced the 2026-07-19 decision to disconnect the CLI flags entirely.

### Why extension system couldn't handle this differently

- The gate lives in this builtin, but it needs the user-override facts on the event; those fields exist on the upstream `BuildSystemPromptOptions` contract and are now populated by the session core.

### Expected merge conflict zones on next upstream sync

- LOW: `index.ts` handler bodies; keep the customPrompt yield and append reattachment when upstream reshapes handlers.

## GLM 5.3 preset (2026-08-16)

### What changed

- `glm-5-3.ts`: new preset for the GLM 5.3 family, cloned from `glm-5-2.ts` (thin `tuningSection` wrapper over the shared dynamic core, `workstationDialect: "claude"`). The tuning text carries "running on GLM 5.3" in place of 5.2; every behavioral directive is identical to 5.2 per the fork direction to copy the system prompt.
- `presets.ts`: `hasGlm53Signal`/`isGlm53Model` matcher (regex `glm(?:[._-]|p)5(?:[._-]|p)3` with `[/@._-]` boundaries), checked BEFORE the 5.2 matcher so 5.3 never falls through to 5.2. `resolvePresetName` branch + `buildPreset` case added.
- `settings.ts`: `"glm-5.3"` joins `PromptPresetName` and `VALID_PRESETS`.
- `docs/settings.md`, `AGENTS.md`, `builtin/AGENTS.md`: preset lists updated.
- `test/suite/prompt-presets-glm-5-3.test.ts`: id resolution across bare/provider-prefixed/fireworks/highspeed/display-name shapes, non-routing of 5.2/4.x, settings force, and a catalog sweep asserting every built-in GLM 5.3 entry resolves.

### Why

- GLM 5.3 shipped in the model catalogs without a preset, so it fell back to the untuned dynamic prompt. Its lineage is identical to 5.2 (Opus 4.6-class, Fable 5 decisiveness, GPT 5.5 outcome-first coding), so the preset is a direct copy.

### Why extension system couldn't handle this differently

- Content-only addition inside this builtin; follows the thin-wrapper preset architecture (`tuningSection` only).

### Expected merge conflict zones on next upstream sync

- LOW: `glm-5-3.ts` is fork-only; `presets.ts`/`settings.ts` touch shared lists — trivial adjacent-line conflicts if upstream adds presets.

## Kimi K3 + GPT-5.6: test-proportionality rules (2026-08-03)

### What changed

- `kimi-k3.ts`: the Verification section opens with a terminal condition — one successful verification command ends the check; one focused test per behavior change at the touched seam; prose, docs, and visual-only changes take review + real-surface QA instead of tests.
- `gpt-5.6.ts`: `TEST_FIRST` scoped — the failing test is written at the seam the change touches; prose, doc, and visual-only changes take review plus real-surface QA, not tests. Header comment updated: the deleted blanket "default to not adding tests" rule returns as a scoped seam rule inside test-first.
- Prose-pinning assertions stripped from `test/suite/prompt-presets-*.test.ts` and other prompt test files; what remains asserts machine-consumed behavior (preset resolution, model matching, rule ids/concerns, tool-name sentinels).

### Why

The 2026-08-03 session-corpus investigation showed K3 writing more test files than any other model (636 writes) and GPT-5.6's preset having deleted its upstream scope rule. kimi.md prescribes terminal conditions over prohibitions; claude-opus-5.md warns explicit verification instructions compound into over-verification. The prose-pinning test removals follow the repo's own convention (`prompt-behavior-coverage`: parsed rule data, never pinned sentences).

### Why extension system couldn't handle this

Presets are core-owned prompt builders; the proportionality rule belongs in the prompt text itself.

### Expected merge conflict zones

- `kimi-k3.ts` Verification section, `gpt-5.6.ts` `TEST_FIRST` constant. Resolution: keep the scoping sentences.

## DeepSeek V4 presets: flash, flash-0731, pro (2026-07-31)

### What changed

- New presets `deepseek-v4-flash`, `deepseek-v4-flash-0731`, and `deepseek-v4-pro`: thin `tuningSection` wrappers over the shared dynamic core (post-2026-04-30 architecture), with the family's shared behavior carried as typed rule data in `deepseek-v4.ts` (`DEEPSEEK_V4_RULES`, gpt-5.6 `GPT56_EXECUTION_RULES` precedent). Rules: `injected-directive-authority` + `todo-discipline` + `missing-info` (all three presets), `settled-reading` (flash line), `reasoning-aim` (pro). Workstation dialect: `claude`.
- `presets.ts`: three matchers on normalized id OR display name with `[/@:._-]` boundaries, verified against the OpenRouter live API, models.dev, and senpi's generated catalogs (official `deepseek-v4-flash`/`deepseek-v4-pro`, OpenRouter `deepseek/deepseek-v4-flash-0731`, HF-style `deepseek-ai/DeepSeek-V4-*`, fireworks `accounts/fireworks/models/deepseek-v4-*`, aihubmix `alicloud-`/`deep-` prefixes, trailing `:free`/`-free`/`:thinking`/`-nothinking`/`-cheaper`/`-lightning`/`-el` tags). The dated 0731 snapshot resolves before the generic flash alias.
- `settings.ts`: `PromptPresetName` + `VALID_PRESETS` gain the three names; `docs/settings.md` value list updated.
- `test/suite/prompt-presets-deepseek-v4.test.ts` (new): table-driven matcher cases from the researched real-world ID shapes, a catalog sweep asserting zero misses across every built-in catalog model with a DeepSeek V4 signal, rule-data placement (each directive rendered exactly once per owning preset, zero leakage into kimi-k3 / gpt-5.6 / glm-5.2), and settings-override coverage.

### Why

- DeepSeek-V4-Flash-0731 running senpi's fallback prompt showed reproducible failure modes: it audits the provenance of harness-injected directives ("the user didn't say ulw-loop... probably residual context"), downsizes mandated workflows as too heavy, oscillates on settled readings ("Actually wait - let me reconsider"), and never updates the todo list. Each rule replaces one of those trained priors with a positive decision rule; the chat-deep.ai DeepSeek prompt guide's structure-compliance findings motivated keeping the presets as decision-rule tuning over the shared structured core rather than a full-core rewrite.

### Why extension system couldn't handle this differently

- Entirely inside the builtin `prompt-preset` extension; no core prompt code changed.

### Expected merge conflict zones on next upstream sync

- NONE expected: `deepseek-v4*.ts` and `prompt-presets-deepseek-v4.test.ts` are fork-only files. `presets.ts`/`settings.ts` additions sit in fork-owned lists that upstream does not carry.

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
