# packages/coding-agent/src/modes/interactive

Interactive mode orchestrates the `senpi` TUI. `interactive-mode.ts` owns startup, session events, key dispatch, overlays, status, and command UI; `components/` owns rendering units.

## STRUCTURE

```text
interactive-mode.ts     Main lifecycle and event-to-UI coordinator
startup-tools.ts        Non-blocking fd/rg capability probe
working-status.ts       Animated working text/frames
session-info-format.ts  Session/cost/token summaries
streaming-reveal*.ts    Paced reveal of streamed assistant content
tool-args-reveal.ts, tool-result-reveal.ts, tool-progress.ts  Progressive tool call/result surfaces
model-search.ts, model-search-rank.ts, model-catalog-refresh.ts  Model picker search/rank/refresh
session-control-host.ts Installs `pi.session.registerControlEndpoint` on a TUI session; submission tickets + editor edges
session-control-endpoint.ts, session-control-lifecycle.ts  Register -> bind -> publish a `tui` endpoint; wake edges; clean exit
session-control-registry.ts, session-control-server.ts     `rpc/tui/t-<16hex>.sock` path (+ /tmp fallback), registry dir, secret-authenticated listener
session-control-commands.ts, session-control-feed.ts      Read-mostly command set; `subscribe` feed (state/report/question/completion)
session-control-wake.ts WakeScheduler (one pass at a time, edges coalesce into one more) + inbox watcher
components/remote-delivery-message.ts  Renders a `session_control_delivery` transcript entry
tips/                   Startup/working tip registry, scheduler, and catalog/ tip sets
grok/                   Grok chrome/palette/welcome-card render surfaces
components/             Messages, tools, footer, selectors, dialogs, editor
theme/                  JSON themes copied into builds
assets/                 Branding assets copied into builds
changes.md              Fork-specific interactive behavior
```

## WHERE TO LOOK

| Task | File |
|---|---|
| Startup and shutdown | `interactive-mode.ts` |
| Streaming assistant render | `components/assistant-message.ts` |
| Streaming tool render | `components/tool-execution.ts` |
| Working animation | `working-status.ts` and `interactive-mode.ts` |
| Footer/status | `components/footer.ts` |
| Model and favorites UI | selector components plus `interactive-mode.ts` |
| Theme behavior | `theme/` and `components/theme-selector.ts` |
| Streaming reveal pacing | `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, `streaming-reveal-content.ts` |
| Startup/working tips | `tips/registry.ts`, `tips/scheduler.ts`, `tips/catalog/` |
| Control endpoint, external admission holds | `session-control-*.ts`, `../../core/external-admission.ts` |

## INVARIANTS

- Preserve memoization in high-frequency assistant/tool renderers; bypassing it causes flicker and excess redraws.
- Startup tool discovery remains non-blocking. Version and package-update checks start asynchronously after the first frame; never await them during startup.
- Preserve the animated Working row, elapsed time, active-tool label, and interrupt hint.
- All keys route through `../../core/keybindings.ts`; no inline key literals.
- Components return styled text through TUI helpers. Arbitrary ANSI styling/output escapes are forbidden; preserve only established terminal-protocol markers such as the OSC 133 zones in `components/assistant-message.ts`.
- Themes remain JSON assets and are copied by package build scripts; do not symlink them.
- Selectors resolve `Promise<T | null>` where `null` means canceled.
- The TUI always runs its own local session; it never joins a multi-session host. Other sessions reach it only through a control endpoint an extension registers (`session-control-*.ts`, docs/rpc.md "Interactive sessions expose a control endpoint"); a TUI with no registrant opens no socket.
- External deliveries never overtake the user: every editor submission holds admission until its input reaches the runtime (a ticket per submission, a hold per prompt/command), and a draft in the editor holds it too. A new submit path must claim or release its ticket.

## ANTI-PATTERNS

- Recomputing complete message trees for every streaming delta.
- Blocking the first frame on tool downloads or update checks.
- Replacing the working animation with a static indicator.
- Writing directly to stdout from components.
- Adding UI behavior without width, theme, and cancellation states.

## VALIDATION

- Run focused component/interactive tests from `packages/coding-agent`.
- Run `packages/tui/test/tui-render.test.ts` when render frequency or memoization changes.
- Every UI change requires root `bun run check`, `senpi-qa` TUI smoke evidence, and visual inspection across relevant terminal sizes.
- Record fork-visible changes in `changes.md` and preserve them during upstream merges.
