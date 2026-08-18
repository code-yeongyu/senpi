# cursor-cli-oauth extension changes

## 2026-08-18 - Default-on native credential bootstrap

### What changed

- `settings.ts`: `cursorCliOauthProvider.enabled` now defaults to true. Explicit
  settings/environment false values remain authoritative.
- `native-bootstrap.ts`: new default managed-credential reader. After the
  enabled and executable gates pass, it copies a usable native `cursor` OAuth
  credential into one canonical `native` slot when managed accounts are
  empty. It re-checks the target inside `CredentialStore.modify`, shares only
  in-flight concurrent reads, preserves existing/incompatible credentials,
  never writes the native provider, and returns the previous state on errors.
  The reader repeats the enabled/executable gate for direct reads outside
  `assessConfiguration` (notably explicit login), so a cancelled login cannot
  bypass `enabled:false`.
- `index.ts`: the builtin registration uses the bootstrap reader only for its
  default `readCurrent`; injected readers keep their existing test/embedding
  behavior.
- Native Cursor login now refreshes the fallback provider in the same
  interactive completion pass; that shared-file change is tracked in
  `packages/coding-agent/src/modes/interactive/changes.md`.

### Why

- A valid native Cursor login plus an installed `cursor-agent` already
  satisfies the fallback lane's real prerequisites. Requiring a second login,
  a settings edit, or `/cursor-account import native` hid otherwise usable
  models and duplicated setup work.
- Startup and native-login refreshes can overlap, so a lock-rechecked,
  in-flight-deduplicated reader is required to avoid duplicate `native-*`
  accounts.

### Why an extension could not handle it

- The bootstrap owns the builtin provider's private credential reader and
  authentication check boundary. External hooks cannot change the default
  settings contract, atomically write the managed provider credential before
  availability is computed, or extend core post-login refresh scoping.

### Expected merge conflict zones

- LOW: fork-only `native-bootstrap.ts`, `settings.ts`, and `index.ts`.
- LOW: `interactive-mode.ts` post-login refresh option construction, tracked
  separately in the nearest interactive `changes.md`.

## 2026-08-18 - Activate explicit login/import and copy native Cursor credentials

### What changed

- `settings.ts`: provider activation now uses the same locked
  read-modify-write path as the no-approval acknowledgement.
  `persistCursorCliOauthEnabled()` preserves every sibling setting, and a
  successful acknowledgement writes `enabled: true` together with
  `noApprovalAcknowledgedAt`.
- `oauth-login.ts`: successful OAuth login requests persisted enablement even
  when the user declines unattended tool execution. The new
  `importNativeCursorCredential()` copies a usable flat OAuth credential from
  the primary `cursor` provider into a canonical named account slot; it never
  writes or deletes the source credential.
- `index.ts`: the real builtin registration now wires both acknowledgement
  and enablement persistence into the OAuth config, instead of leaving the
  login-time acknowledgement as an unwritten optional callback.
- `account-command.ts`: `/cursor-account import native` explicitly copies the
  primary provider credential. Local and native imports persist enablement
  and run a scoped offline availability refresh so the current session's
  model selector updates without restart.

### Why

- The fallback provider registered its model catalog but remained hidden after
  successful login/import because `cursorCliOauthProvider.enabled` defaulted
  false and the explicit actions never changed it.
- Users with a valid native `cursor` OAuth credential had to copy token
  material by hand into the fallback provider's sentinel `accounts[]` shape,
  risking accidental removal of the primary credential.
- The login acknowledgement prompt claimed success but the production
  registration did not supply the persistence callback.

### Why an extension could not handle it

- These are the fallback extension's private OAuth, settings, account-command,
  and provider-registration boundaries. No external extension can rewrite the
  builtin provider's credential shape, add persistence to its login callback,
  or refresh its private model-runtime availability after import.

### Expected merge conflict zones

- LOW: fork-only `settings.ts`, `oauth-login.ts`, `index.ts`, and
  `account-command.ts`; conflicts are expected only with concurrent hardening
  of the same Cursor CLI OAuth lane.

## 2026-08-17 - Initial builtin fallback lane

Plan: `.omo/plans/cursor-cli-oauth.md`. Probe evidence: `local-ignore/qa-evidence/20260817-cursor-cli-p-lane/`.

### What changed

- New builtin extension `cursor-cli-oauth`: runs senpi turns through the official `cursor-agent` CLI in print mode (`-p <prompt> --output-format stream-json --stream-partial-output --trust`, plus `--model`, `--resume`, `--force`, `--mode plan`, `--sandbox` when configured) instead of the native api2.cursor.sh protobuf provider. The native `cursor` provider stays the first-party primary path; this lane is the documented fallback for when the native path misbehaves or Cursor's own agent harness is explicitly wanted.
- Registration is unconditional: `index.ts` registers the provider with the offline static model catalog first and swaps in the probe-backed catalog asynchronously, so a missing, hanging, or broken `cursor-agent` never hides or delays the lane. The oauth `check` reports exactly one of `configured (file-store, <n> accounts)`, `disabled by settings`, `cursor-agent not installed: <guidance>`, or `no accounts: run /login cursor-cli-oauth`.
- Auth is file-store only. Each account gets a durable sandboxed HOME at `<agentDir>/cursor-cli-oauth/accounts/<slot>/home` holding `.cursor/auth.json` (`accessToken`/`refreshToken`/`apiKey: null`/`bedrockCredentials: null`, mode 0600 inside 0700 directories), rewritten immediately before every spawn and read back afterwards to persist rotated refresh tokens. The child environment is an explicit allowlist (`HOME`, `PATH`, `AGENT_CLI_CREDENTIAL_STORE=file`, `TERM`, `LANG`, `LC_ALL`, `FORCE_COLOR`). There is no ambient lane: the only code that reads the user's real Cursor store or keychain is the explicit `/cursor-account import` command, and imported tokens are copied into a slot, never referenced. `CURSOR_API_KEY` is never set; the system keychain is never written.
- Multi-account support: sentinel top-level credential fields (`cursor-cli-oauth-managed`) with real tokens only inside `accounts[]`; HRW (rendezvous) session affinity duplicated inside this extension; block windows (`rate_limit` bounded by server hint else 60 s, capped at 48 h; `auth_error` until re-login); failover rotates accounts only before any visible assistant delta and always starts a fresh chat with a user-visible notice - chat context is never transferred between accounts because each account's chats live in its own HOME.
- Session routing: sticky `{accountName, chatId, lastModel}` per senpi session, captured from `system/init.session_id`. Switching models mid-session keeps the same chat id via `--resume` and prepends a one-turn 8 KB context recap from senpi's own records; resume failure or a classified `context_overflow` starts a fresh chat with the recap and surfaces a notice. Prompt plus recap is shrunk to the 130 KB argv ceiling before spawning and only then errors.
- Context ownership stays with senpi (load-bearing): `usage.input` is senpi's own `estimateTokens` of the payload it actually spawned, `usage.output` is the CLI's reported `outputTokens`, and `cacheRead`/`cacheWrite`/`totalTokens` stay 0; the CLI's `inputTokens`, `cacheReadTokens`, and `request_id` live only in a `cursor_cli_oauth_cli_usage` assistant diagnostic for telemetry. No core compaction file is modified and no `session_compact` handler is registered, so the F1-F4 compaction wedge classes from the Claude lane cannot arise.
- Guardrails for unattended execution: `--force` is emitted only when `noApprovalAcknowledgedAt` is set - otherwise the first attempt is a typed refusal naming the exact acknowledgement step; `executionMode: "plan"` never forces; `forceExecution: false` in agent mode warns once per session (the CLI auto-rejects tool calls without force and the model then fabricates output); sandbox modes are limited to the probe-proven `enabled`/`disabled` with one warning per rejected value; deny lists are sanitized to exact full commands and applied per-spawn as `permissions.deny` `Shell(<command>)` entries in the account HOME's `cli-config.json`, composing with CLI-owned keys.
- Lifecycle safety: children spawn detached in their own process group and are killed by tracked pid (SIGTERM to the group, SIGKILL after a 5 s grace) on abort and on `session_shutdown` - never by name matching (senpi #823 regression class); every deferred continuation is fenced per extension generation so a retired generation is never touched after a reload (senpi #866 regression class).
- Missing-CLI UX: `CursorAgentNotInstalledError` carries the `curl https://cursor.com/install -fsS | bash` guidance and the `~/.local/bin` PATH note; the executable resolution chain is env override -> settings -> PATH probe -> newest `~/.local/share/cursor-agent/versions/*`; `/cursor-account status` reports the file-store lane, senpi as context owner, chat id, last model, executable path and version with a one-time below-floor warning (minimum known-good `2026.08.11`), block windows, and recommends the native provider when it is also configured.

### Why

- The native Cursor provider is the primary path; a fallback lane was needed for protocol drift or transport failures on the native path, and for users who explicitly want Cursor's own agent-harness behavior (its tool execution, its model ladder).
- The CLI refuses the OAuth session token as an API key but accepts the same token through its file-based credential store, so per-account HOMEs give credential isolation, separate chat histories per account, and immunity to a locked macOS keychain.
- Keeping senpi as context owner avoids the Claude-lane compaction wedge: `estimateContextTokens` treats the last assistant usage as the authoritative context base, so CLI-reported context numbers must never reach `usage` fields - they would make senpi demand a compaction only the CLI could perform.

### Why an extension boundary could not avoid it

- A builtin provider must appear in two core-owned lists that have no external hook: `extensions/builtin/index.ts` (the `builtinExtensions` registry array plus its import) and `provider-display-names.ts` (the display-name map the `/login` and auth-status surfaces read). Those two files are this lane's entire shared-file footprint; see the companion entry in `packages/coding-agent/src/core/changes.md`.
- Usage isolation must happen inside the provider's own `streamSimple` before the assistant message commits - no extension hook can quarantine the CLI's numbers after that boundary.
- Executable resolution, credential injection, and the spawn env allowlist sit at the private subprocess boundary this extension owns; nothing outside it can observe or narrow them.

### Expected merge-conflict zones

- MEDIUM: `extensions/builtin/index.ts` at the import cluster and the registry array beside the `claude-sdk-oauth` entry - every new builtin lane edits the same two hunks.
- LOW: `provider-display-names.ts` map rows (one-line additions in a sorted literal).
- LOW: this directory is fork-new, so conflicts arise only if upstream lands a lane of the same name. Within it, `stream.ts`, `oauth-login.ts`, `settings.ts`, and `account-command.ts` are the active iteration surfaces during hardening.
