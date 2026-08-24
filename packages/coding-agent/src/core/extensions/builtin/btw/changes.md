# changes — btw

## 2026-08-23 - Retained native TUI side sessions

### What changed

- In TUI mode, every `/btw <question>` creates a distinct host session with versioned root-parent
  metadata, stable `BTW #N: <summary>` naming, a hidden bounded Main-context snapshot, no active
  tools, and a native transcript.
- Bare `/btw` opens the native selector with Main, numbered retained sides, and New BTW. The popup
  renders the effective switch keys and always shows `/btw`; defaults are Ctrl+/, Ctrl+_, and
  Ctrl+7 so editors that reserve Ctrl+/ still have a terminal fallback.
- A configured switch input opens the same picker. Two idle interrupt keys inside one second return
  to Main without deleting the side. The configured clear key switches to Main and then deletes
  only the visible side.
- Catalog reads revalidate selected paths, skip stale/corrupt rows, recover root scope from side
  metadata after reload, and keep failed deletions discoverable.
- The fresh replacement context applies the captured model and thinking level before the first
  answer. The typed `newSession` policy capability persists a tool ban without crossing the
  extension/core boundary; it forces later MCP/tool-search activation to an empty effective set
  and rejects Cursor exec registered-tool lookup. Final provider payload enforcement removes
  provider-native tool definitions after every extension transform.
- Parent snapshots use Main's active leaf when Main is visible, so a side never captures an
  abandoned physical tail after tree navigation. The selected Main leaf is persisted in side
  metadata and inherited by siblings created from a side.
- A newest message larger than the 64k snapshot budget is truncated into the snapshot instead of
  dropping all parent context.
- Inline and New BTW creation wait for Main to settle, then reload the catalog before snapshotting
  so the leaf and content describe the same completed turn.
- The typed `newSession` contract flushes initialized sides before returning, so an empty New BTW
  remains in the disk catalog. Discovery and parent inspection use typed command-context
  capabilities instead of importing core session internals.
- An assigned Main session path must exist on disk before BTW can catalog or create retained sides.
- The switch binding yields to any active extension dialog, and captured model authentication is
  preflighted before Main can be replaced.
- Native web-search, bash, and image prompt contributors consult the typed session tool-policy flag
  and never advertise unavailable tools inside retained sides.
- Active-dialog detection covers selectors, text inputs, and full extension editors before the BTW
  switch shortcut can dispatch.
- Inline questions require an active model before replacement; catalog membership requires the
  retained side's parent path and parent session ID to match Main.
- Main return, close, and picker selection restore the side's captured parent leaf. Shortcut
  re-entry is gated by the renderer's actual focused component, including native login dialogs.
- Ctrl+C yields to focused dialogs, duplicate clone labels include stable session identity, and
  return/close verify the destination Main ID before switching or deleting.
- Raw switch dispatch reserves the TUI command before queueing, and picker choices carry expected
  session IDs for post-selection reinspection.
- Close revalidates the visible side ID immediately before unlink. Catalog discovery reads only a
  bounded custom-metadata prefix instead of parsing full transcripts.
- Captured model preflight runs the provider's live asynchronous auth check before Main replacement.
- Catalog discovery uses header-only session listing before bounded custom-metadata reads. Main-leaf
  restoration runs after every close attempt, including identity mismatch and unlink failure.
- Header discovery skips malformed/unreadable files, and catalog construction independently seeds
  the active session and retained parent even when they live outside the configured session directory.
- Return/close/picker Main preserve the configured session directory for external Main files.
  Dialog-owned Escape resets the idle return pair before the focused component handles cancellation.
- Inline creation requires an identity-matched Main. Authoritative current/parent seeds survive cwd
  recovery, and all builtin tool-specific prompt contributors honor the retained no-tools policy.
- Settled creation revalidates the active/selected parent ID. Recovered catalogs request unfiltered
  header candidates before exact parent matching, and imagegen skill discovery honors no-tools.
- MCP instruction injection also short-circuits before attachment when the retained policy disables tools.
- Destructive close has its own pending/running reservation, and parent/side/picker identity checks
  use bounded header metadata instead of loading full transcripts.
- Switch and close reservations cross-gate each other, so one BTW session action owns replacement.
- Switch, close, and Main return share one action-kind state. MCP startup skips attachment entirely
  under retained no-tools policy.
- Ordinary loaded skills are removed from retained system-prompt options so no read-tool guidance leaks.
- Raw switch, close, and Main shortcuts resolve this builtin's collision-safe invocation name before
  reserving or dispatching, so renamed commands cannot fall through as model prompts.
- Model-specific prompt presets are suppressed under retained no-tools policy before replacement.
- New BTW creation requires selected and settled Main IDs to match the active visible parent ID.
- Catalog custom-data scans prefilter rows by effective cwd plus the active session's persisted cwd.
- Retained creation rechecks the parent header ID after auth and immediately before `newSession()`.
- Parent-path keyed action reservations survive extension-runner rebind until replacement callbacks settle.
- Disabled model selection resets prompt presets instead of reinstalling tool guidance.
- Retained creation rechecks idle state plus source session/leaf identity after auth and before replacement.
- Parent context is built inside retained creation after its final idle wait and source leaf capture.
- Existing picker targets wait idle, revalidate identity, wait idle again, then switch.
- Picker switches carry the selected session ID through the host switch boundary, which reopens
  and verifies the target after every asynchronous `session_before_switch` veto before teardown.
- Direct Main return and destructive close carry the expected Main ID through the same guarded
  switch boundary.
- Catalog discovery rejects current-path side metadata whose persisted header ID no longer matches
  the live session manager.
- Retained creation carries the expected Main ID through new-session veto and shutdown hooks, while
  guarded switches reopen and verify their destination again after outgoing-session teardown.
- A post-teardown identity cancellation recreates and rebinds a valid outgoing runtime before
  returning, and expected-parent checks read bounded header metadata rather than full transcripts.
- Recovery snapshots preserve the outgoing ID, tree, and effective cwd when its path was reused;
  resume and new-session transitions revalidate again after asynchronous runtime construction.
- Discarded candidate runtimes run their normal shutdown lifecycle before disposal, and persisted
  recovery candidates revalidate after construction before the host rebinds them.
- Expected target/parent identities are checked again after removed-extension handlers, and BTW
  passes source ID/leaf expectations so activity begun during a switch veto cancels replacement.
- Source expectations record whether the command began idle, preserving streaming Ctrl+C close;
  once teardown starts, the outgoing session rejects new prompts until replacement completes.
- A monotonic prompt-admission generation travels with source expectations, so a streaming-origin
  close cancels if any later queued or direct prompt is submitted while switch vetoes await.
- Guarded identities revalidate after host rebind and before replacement callbacks; command-action
  option types derive from the public context signatures so typed hosts retain every guard.
- Replacement candidates stay externally prompt-locked through rebind/callback completion, and a
  cancelled guarded creation removes only its still-owned initialized side file.
- Replacement locking covers extension-triggered turns with a scoped callback privilege; cancelled
  side cleanup atomically quarantines before validation/deletion and always restores runtime first.
- Callback privilege is applied only to individual replacement-context method admission, and
  cleanup checks ownership before quarantine while retaining the post-rename race check.
- Recovery metadata failures keep the detached snapshot; custom trigger turns advance source
  generation; replacement-pending admits only the registered collision-safe BTW close command.
- The switch reservation releases after the retained initial turn is admitted, allowing Ctrl+C to
  acquire the close reservation while a slow or hung first answer is still streaming.
- Initial-turn admission is signaled by the host only at its real provider-start boundary, never
  when asynchronous prompt preflight merely begins.
- Rejected fire-and-forget shortcut dispatch rolls back only its captured pending reservation, so
  a replacement guard cannot permanently consume later BTW switch, close, or Main shortcuts.
- Abort-generation cancellation of a settlement-deferred shortcut reports the same rejection,
  releasing the pending reservation even when its command action never executes.
- Deferred delivery clears its old generation before that rollback callback, so any synchronous
  retry dispatches into the live session instead of the discarded settlement batch.
- Side deletion hard-links an atomic inode claim before validation, compares the moved directory
  entry to that claim, and restores path-reused replacements without overwriting concurrent data.
- Non-TUI modes retain the existing parallel, read-only, one-shot provider query.

### Why

- One custom widget could not represent multiple retained side conversations, use the host
  transcript scrollback, survive reload/navigation, or make destructive close unambiguous.

### Expected merge-conflict zones

- MEDIUM: `index.ts` command and session-start wiring.
- LOW: `session-catalog.ts`, `retained-session.ts`, `tui-command.ts`, `input-controls.ts`, and
  `session-actions.ts` are extension-local additions.
- LOW: `core/keybindings.ts`, extension UI context types, and interactive UI context wiring.

## 2026-08-13 - Preserve provider-header deletion markers

### What changed

- `/btw` passes model-registry `ProviderHeaders` directly into the runtime stream options, including `null`
  values that delete inherited provider headers.

### Why

- The upstream auth contract widened during this merge. Materializing headers early would make a side query
  retain a header that the active provider configuration explicitly removed.

### Why an extension could not handle it

- This is the builtin command's private registry-to-stream boundary; an external hook cannot restore a deletion
  marker after it has been dropped.

### Expected merge-conflict zones

- LOW: `index.ts` auth forwarding and `side-query.ts` `SideQueryAuth`.

## Model-aware side-query context budgeting (2026-08-12)

### What changed

- `/btw` now budgets the complete side-query prompt against the selected model's context window, including output
  reserve, the session system prompt, the side-query instruction, captured history, and the final question.
- Oversized captured snapshots run through the existing deterministic context reducer, orphaned tool-result repair, and
  oldest-first pruning before provider dispatch. Small snapshots remain unchanged.
- If mandatory prompt content cannot fit, `/btw` fails locally with an actionable `/compact` suggestion instead of
  sending a provider request that is guaranteed to be rejected.

### Why

- `/btw` previously bypassed the main-turn context pipeline and replayed the full captured session snapshot directly to
  the provider. Large sessions could therefore fail with `Your input exceeds the context window of this model` even
  while normal main turns continued successfully.

### Why an extension could not do this

- The failure is inside the builtin command's private snapshot-to-provider path. An external extension cannot intercept
  and structurally budget that ephemeral provider payload without replacing the builtin command.

### Expected merge-conflict zones

- `index.ts` around captured snapshot construction and side-query dispatch.
- `side-query.ts` around context assembly and model runtime options.
- `test/suite/btw-side-query.test.ts` around the builtin command and context-builder regression coverage.

## Runtime provider dispatch for side queries (2026-07-30)

### What changed

- `/btw` now passes a stream function backed by `ctx.modelRegistry.modelRuntime`
  into the side-query runner instead of allowing it to fall back to the compat
  API registry.
- Added issue #488 regression coverage with a provider whose API id exists only
  in Senpi's runtime registry.

### Why

- Providers registered through `pi.registerProvider()` work in the main loop but
  may not exist in compat's built-in API registry. `/btw` therefore failed before
  invoking their registered stream implementation.

### Merge-conflict zones

- `index.ts` side-query dependency construction only.

## Parallel side questions via `/btw` (2026-07-21)

### What changed

- New builtin extension `btw` registering `/btw <question>`: runs a read-only side
  LLM query against a snapshot of the current conversation, in parallel with any
  in-flight main turn, without writing anything back to session history.
- `side-query.ts`: builds the side context (session system prompt plus a
  side-question instruction, snapshot history, question as the final user
  message, `tools: []`) and streams it through `streamSimple` with an
  establishment timeout (default 30s), abort propagation, and text-delta
  callbacks. Provider `sessionId` is suffixed `:btw:<uuid>` so provider-side
  session affinity never collides with the main turn.
- `index.ts`: the command handler captures the context snapshot synchronously
  (entries + leaf at invocation time) before its first await, so a concurrent
  main turn or compaction cannot create a mixed-generation request. A new
  `/btw` aborts and replaces the previous one; `session_before_switch` aborts
  any active query.
- `panel.ts` (TUI only): renders the question and streaming answer in a widget
  above the editor. Escape always passes through to the main TUI untouched; as a
  side effect it also dismisses the panel and aborts the side query, so one
  Escape cancels in-flight side work without ever stealing the main interrupt.
  A settled panel auto-dismisses on the next submitted message.
  Non-TUI modes skip the widget and deliver the answer through `ctx.ui.notify`.
- `builtin/index.ts`: registers the extension after `goal` and before `mcp`.
- Coverage: `test/suite/btw-side-query.test.ts` proves no history pollution,
  parallel execution with an in-flight main turn, synchronous snapshot
  isolation, previous-query abort, provider error propagation, establishment
  timeout, and pre-aborted signals — all on the faux provider, zero tokens.

### Why

- Users need a way to ask questions about the ongoing session (or anything
  else) without derailing or polluting the main agent's context, and without
  waiting for the main turn to finish.

### Known limitations

- Escape is matched as the raw terminal key; the extension API exposes no
  keybinding lookup from command contexts, so a remapped `app.interrupt` key
  is not honored by the widget.
- The side query streams through `streamSimple` directly (same pattern as core
  compaction): auth resolution goes through the model runtime, but session
  `before_provider_request` hooks and retry policy do not apply to side calls.

### Merge-conflict zones

- `builtin/index.ts` import block + `builtinExtensions` array (single added
  line each; keep the `btw` entry ahead of `mcp`).
