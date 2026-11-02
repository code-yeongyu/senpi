# packages/coding-agent/src/core/dynamic-prompt

Fork-introduced system-prompt assembler. Replaces upstream's static `buildSystemPrompt()` with a layered builder: identity → intent gate → working-task → verification → tool reference → policies → handoff → style → optional per-model tuning. Every preset under `extensions/builtin/prompt-preset/` ultimately calls into this builder. See `changes.md` for the full evolution.

## FILES

```
dynamic-prompt/
├── build.ts                # buildDynamicSystemPrompt() + BuildDynamicSystemPromptOptions (+ corePrompt override) — assembler, public entry
├── index.ts                # Public re-exports
├── types.ts                # AvailableTool, PromptSurface
├── identity.ts             # buildIdentitySection() — senpi neutral identity
├── intent-gate.ts          # buildIntentGate() — routing line with declared stop condition + intent-family rules
├── working-task.ts         # buildWorkingTaskSection() — parallel waves, exploration stops, one-plan commitment
├── verification.ts         # buildVerificationSection() — V1/V2/V3 verification tiers
├── tool-categorization.ts  # categorizeTools() + getToolsPromptDisplay()
├── tool-section.ts         # CATEGORY_ORDER + CATEGORY_LABELS for rendering
├── policies.ts             # Hard blocks injected into every prompt
├── handoff.ts              # buildHandoffSection() — labeled handoff block (Ask / For you / Now / Next): when progress reaches the user, and what it carries; the Claude and Kimi K3 cores render it too
├── style.ts                # buildStyleSection() — output formatting + length norms
└── changes.md              # Dense fork tracker (dated sections)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Change senpi identity | `identity.ts` |
| Add/modify intent classification | `intent-gate.ts` — the forced verbalization line |
| Change parallel-tool/exploration guidance | `working-task.ts` |
| Add new "Don't do X" rule | `policies.ts` |
| Tune verification tier definitions | `verification.ts` |
| Add/remove a tool category | `types.ts` (`AvailableTool["category"]`) + `tool-categorization.ts` + `tool-section.ts` |
| Per-model addendum to the prompt | callers pass `tuningSection` (see `extensions/builtin/prompt-preset/`) |
| Full per-model core rewrite | callers pass `corePrompt` (see `prompt-preset/gpt-5.5.ts`) — replaces identity→style, keeps tool section/context/skills/workstation assembly |

## SECTION ORDER (assembled in `build.ts`)

1. **Identity** — senpi-neutral hero line
2. **Intent gate** — forced `I read this as [intent] - [plan]. I'll stop when [...]` routing line (terminal surface) + intent-family rules
3. **Working the task** — parallel waves, read-before-claim, exploration stops, one-plan commitment
4. **Verification** — V1/V2/V3 tiers + claim audit
5. **Tool reference** — categorized snippets + guidelines from registered tools
6. **Policies** — hard blocks
7. **Handoff** — when and how progress reaches the user
8. **Style** — execution stance + output formatting
9. **Optional `tuningSection`** — per-model preset addendum (appended last)

When `corePrompt` is set, sections 1–8 are replaced by the override's output (the rendered tool section is handed to it via `DynamicPromptCoreContext`); tuning, context files, skills, and workstation assembly are unchanged.

The prompt carries no date or cwd: both reach the model as an append-only `environment-context` custom message (`core/environment-context.ts`, injected by `agent-session.ts` before a turn when a value changes) so the system prompt is byte-stable across days and directories (senpi#2093). Never add per-turn values back here.

## CONVENTIONS

- **Forced verbalization** (2026-04-30): every terminal-surface prompt mandates a `I read this as [intent] - [plan].` line. Do NOT silently revert to "internal-only" routing there — the 2026-04-30 entry reversed that experiment.
- **Prompt surface** (2026-09-29, senpi#2377): `surface` (`BuildDynamicSystemPromptOptions`, `DynamicPromptCoreContext`) comes from the session's launch profile (`open_session.promptSurface` on a shared RPC host) and otherwise from `SENPI_PROMPT_SURFACE=app` (`resolvePromptSurface`, read in `agent-session.ts`); anything else is `terminal`. On `app` (a host that renders replies as chat) every built-in prompt keeps its intent-family rules and stop-condition discipline, carries NO routing-line instruction or reference (replaced at the source, never contradicted by an appended rule), and its claim audit (the verification text, never the Intent Gate) covers a check that did not run with the evidence that did run and is the one home of the tool-and-hook-feedback guidance (`APP_UNRUN_CHECK_RULE`). Terminal renders stay byte-identical; `test/suite/prompt-presets-app-surface.test.ts` checks both surfaces for every preset.
- **Chat surface** (2026-09-30, senpi#2398): `chat` (a chat bridge posting replies to people) takes every `app` rule through `terminalOrApp()` and differs only in having NO handoff block: `buildHandoffSection` returns `CHAT_REPLIES_SECTION`, and each core's final-message rule opens with `CHAT_FINAL_MESSAGE` instead of the Handoff block. A new wording table for app and terminal is keyed by `TerminalOrApp`; one that differs on chat is keyed by `PromptSurface`.
- **Anti-leakage guard preserved**: the prompt forbids narrating "Step 0", "Thinking level", or XML tool-call examples in user-visible output. Keep this even if routing is verbalized.
- **No coding-specific language in the default** (2026-04-11): identity is domain-agnostic. Coding-specific tuning belongs in a preset, not here.
- **Section builders are pure functions** taking only the data they need from `BuildDynamicSystemPromptOptions` — easy to test in isolation and reuse from presets.
- **Tool categories are fork-narrowed to 4** (search/session/command/other). LSP and AST categories were removed (2026-04-11).

## ANTI-PATTERNS

- Hardcoding model-specific instructions in `build.ts` — put them in a preset's `tuningSection` instead.
- Reintroducing `lsp`/`ast` tool categories without re-adding their detection + tests.
- Replacing the senpi identity with `"You are a helpful assistant."` — was tried, produced weak generic-bot output, reverted 2026-04-30.
- Removing the intent-gate verbalization line from the terminal surface — the README advertises it; code must match.

## NOTES

- `buildDynamicSystemPrompt(options)` is the only public entry; presets pass `tuningSection` to layer on per-model guidance.
- `changes.md` documents the layered rewrite in dated sections. Read it before touching `build.ts` or `intent-gate.ts`.
- Tests live under `packages/coding-agent/test/dynamic-prompt/` and the preset suites under `test/suite/prompt-presets-*.test.ts`.
