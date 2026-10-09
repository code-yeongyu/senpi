# Permission System Builtin Extension

## 2026-10-06 - Invocation-scoped dispatch authorization (#2843)

### What changed

- `dispatch.ts` owns session-scoped authorizer registration and invocation-scoped approvals keyed by the validated input object. It keeps the policy and operation presented before an approval wait, rechecks live authority at dispatch, and invalidates retired registrations without removing their replacements.
- `dispatch.ts` removes a comparison of the readonly dispatch identity with its own copy. The MCP resolver still compares live metadata immediately before dispatch; argument, registration, approval and live-policy fences remain independent.
- `dispatch.ts` retains retirement state in the session registry instead of erasing required authority. Inline/factory loads do not become indistinguishable from never-loaded enforcement; approval preparation, approval settlement and final dispatch all reject the retired registration.
- `service.ts` exposes the matched rules alongside its existing decision so final dispatch uses the same evaluator as permission prompts and pending-request rechecks.
- `dispatch-metadata.ts`, `dispatch-policy.ts`, `index.ts`, and `prompt.ts` connect the authorizer to the existing live parser, evaluator, preset, and approval UI. Offered operation evidence is captured before approval; unique registration lifetimes cancel pending prompts when retired, including re-registration of the same callback object.
- `test/permission/dispatch.test.ts` covers independent identical calls, unchanged Once approval, changed policy or operation, authority retirement, cancellation, and the real session's preflight-to-execution input ownership.

### Why

- Nonblocking MCP startup must reconcile stale metadata and live permission before invocation rather than relying on approval obtained before connection readiness.

### Must not break

- A Once approval covers only its invocation, arguments, operation, and relevant policy.
- Preset restrictions and existing remembered consent retain their existing evaluation order.
- A retired authorizer never grants authority, and old cleanup never removes a newer registration.

### Conflict zone

- `service.ts` decision evaluation and the MCP invocation resolver's authorization boundary.

## 2026-10-04 - No-UI refusal only; ref-shaped git operands by lstat

### What changed

- `non-interactive.ts`: `handleNoUI(request, { emitEvent, presetBound })` always returns the refusal. It is only reached for a request the service is still asking about, so its old allow outcome could never apply and its deny outcome only ever refused too; `index.ts` replies with it directly.
- `auto-paths.ts` + `auto-policy.ts`: a ref-shaped git operand counts as a path when anything exists at that name, a dangling symlink included (`existsAtName`, an `lstat`); before, a dangling project symlink was treated as missing and allowed. A name `lstat` refuses (too long, a loop) also counts as a path, so it asks instead of throwing.

### Why

- Follow-ups from the round-8 review of #2614 (no blockers).

### Must not break

- No-UI mode never approves a request the service asked about.

## 2026-10-04 - No-UI requests fail closed; plain-word shell splitter

### What changed

- `non-interactive.ts`: `handleNoUI(request, options)` judges every pattern of the request (CLI override before the static ruleset), allows only when all are allowed, and rejects on any deny; `index.ts` refuses whenever it does not allow, so a request the service still asks about is never answered "once" without a UI.
- `auto-shell-segments.ts`: only plain words joined by `;` or `&&` (the same character set the judge accepted before); the unreachable quote, redirect, pipe and glob handling and `ShellWord.hasGlob` are gone.
- `auto-program-rules.ts` + `auto-policy.ts`: a ref-shaped git operand (`ref-or-path`) asks when something exists at that name and is not an approvable project path, or when it is credential-shaped.
- `auto-policy.ts`: `grep` with an empty path list asks. `service.ts`: the unreachable judge branch outside `presetBound` is gone.

### Why

- Round 7 of the #2614 review: the round-6 "answer a no-UI allow" approved a multi-path `external_directory` request whose later path no rule allowed (`handleNoUI` judged only the first pattern).

### Must not break

- No-UI mode never allows what the service asked about; every pattern of a request is judged.

## 2026-10-03 - Auto: one decision for ask, the pending re-check and no-UI

### What changed

- `service.ts`: `decide()` is the single decision for a call. `ask` uses it, and so does the re-check of still-pending requests after an "Always" reply (each pending request keeps the options it was asked with). Under `presetBound`, settings and CLI rules combine with the preset as the more restrictive; an "Always" answer given in this session then allows its pattern.
- `non-interactive.ts` + `index.ts`: with `auto` and no UI, a call the service still asks for is refused with a reason (no configured allow can answer it); a no-UI allow is now answered with `once` instead of leaving the call waiting.
- `auto-policy.ts`: a session root that is not a project (`/`, home or above, a hidden directory) approves nothing, shell commands included.
- `auto-program-rules.ts`: a flag's value (`git log -n 1000`) is not treated as an object id.

### Why

- Round 6 of the #2614 review: the no-UI path hung on `auto` + `--permission bash=allow`; the pending re-check after "Always" still used the order-dependent evaluation and approved a pending `rm`; shell commands without a path were approved in a home or `/` root.

### Must not break

- Every path that decides a call goes through `decide()`; a configured user rule can only narrow `auto`.

## 2026-10-03 - Auto: preset and user decisions combine as the more restrictive

### What changed

- `service.ts`: with `presetBound` (set by `index.ts` while `auto` is active), each call is decided twice, independently: the preset's rules alone (its blanket ask becomes allow when the judge approves) and the user's rules alone; the final action is the more restrictive of the two (deny > ask > allow). Rule order and layer no longer matter, so a user `allow` cannot widen `auto` and a user `deny`/`ask` always narrows it. This replaces the round-4 `userRestrictionFor` lookup, which still let a user `allow` ordered after the preset win.
- `auto-paths.ts`: a session root inside a hidden directory (`~/.config/...`) approves nothing.
- `auto-policy.ts`: `apply_patch` with a delete asks; `multiedit` (no such tool in senpi, so no resolver) asks.
- `auto-program-rules.ts`: hex operands of 4+ characters count as object ids and ask; `cat`/`head`/`tail`/`wc`/`cut` need a file and `grep`/`rg` a pattern plus a file, so none waits on terminal input.

### Why

- Round 5 of the #2614 review: precedence was order-dependent (a user allow after the preset in the same settings file, or `--permission bash=allow`, deleted a file unprompted).

### Must not break

- A user rule may only narrow `auto`; the combination must not depend on rule order or layer.

## 2026-10-03 - Auto: a user allow never widens it; home-ancestor roots, git operands

### What changed

- `service.ts`: with `auto` active, only a user `deny` or `ask` for the call replaces the preset's rule (`userRestrictionFor`); a user `allow` is ignored there, so it cannot let a call skip the judge.
- `auto-paths.ts`: a session root that is `/`, the home directory or any ancestor of it (`/Users`, `/home`) approves nothing.
- `auto-program-rules.ts`: a `git diff`/`log`/`rev-parse` operand that is not a plain ref is checked as a project path; the dead `show` branch is gone.
- `auto-policy.ts`: `decideAuto` is async and judges `read` with the tool's own `resolveReadPathAsync`.

### Why

- Round 4 of the #2614 review: a project `bash: allow` plus `auto` deleted a file with no prompt (only `deny`/`ask` are promised to win); a `/Users` root counted as a project; git operands were never path-checked.

### Must not break

- A user rule may only narrow `auto`, never widen it.

## 2026-10-03 - Auto decides on the tool's own resolved target; user rules win from every layer

### What changed

- `auto-policy.ts`: each decision uses the target the tool itself computes: `resolveReadPath` for `read` (every quote layer and macOS name fallback the tool tries), `resolveToCwd` for `write`/`edit`/`multiedit`/`ls`/`find`/`grep`, and `parsePatch` + `resolvePatchPath` for `apply_patch`. `bash_input` and a `monitor` path always ask. Shell commands are judged only when made of plain words joined by `;` or `&&` (no quotes, escapes, expansions, redirects, pipes, `:` or `..`), and only for the read-only programs left in `auto-program-rules.ts` (`cp`, `mv`, `rm`, `mkdir`, `touch`, `sort`, `uniq`, `cd` and `git show` removed; full object ids ask).
- `auto-paths.ts`: one resolver (`realpathWithoutOpenStrict`) instead of a second implementation; a session root equal to the home directory or `/` approves nothing; `.vscode` left the safe hidden list.
- `service.ts` + `index.ts`: with `auto` active, when the matching rule is the preset's own, a user rule for the same call (from any layer, ordered before or after the preset) decides instead (`userRulesBeatPreset`).

### Why

- Round 3 of the #2614 review: the policy re-derived paths in parallel with the tools and missed nested quotes, macOS name fallbacks, a patch header with U+2028, a blob read through `git show`, a logical `cd`, and `cp` into a directory holding a symlink; a project rule ordered before a CLI/RPC-selected preset was shadowed by it.

### Must not break

- The judge must call the tools' resolvers, never a copy; if a tool changes how it resolves a path, the decision follows automatically. A user `deny`/`ask` beats the `auto` judge whatever layer it comes from.

## 2026-10-03 - Auto preset becomes an allowlist

### What changed

- `config.ts`: the `auto` preset's rules are a single `*:*=ask`; it no longer inherits accept-edits' `read/list/grep/edit=allow`.
- `auto-paths.ts` (new): resolves a path the way the file tools do (`@` stripped, Unicode spaces, `~`/`$HOME`, `read`'s quoted fallback) and then physically, component by component, so a symlink is followed before a later `..` (`resolvePhysicalPath`; a missing tail must be plain names). `isApprovableProjectPath` accepts only a resolved path inside the resolved project root with no hidden component (except `.github`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, `.node-version`, formatter/linter configs, `.vscode`) and no credential-shaped name.
- `auto-shell-grammar.ts` (new) + `auto-program-rules.ts`: each allowed program has a full flag grammar; every flag, attached value (`-o/x`, `-ro/x`, `--output=x`) and operand is classified as read-file, list, write, remove-file or text, and an unknown flag or form asks. The set is file utilities (`ls cat head tail wc diff stat file sort uniq cut grep rg mkdir touch cp mv rm echo pwd true which`) and read-only git (`status`, summary-only `diff`/`show`, `log`, `rev-parse`, `ls-files`, `blame`, `branch`). Test runners, builds, package managers and installs were removed.
- `auto-policy.ts`: approves `read`, `ls`/`find`, `write`/`edit`/`multiedit`/`apply_patch` only when every path the tool will touch is approvable, `grep` only on regular files, and shell commands only when every segment parses and every path word is approvable both as written (traversal order) and lexically. Anything else returns no approval. `requireApproval` is gone (the preset already asks).

### Why

- Two review rounds on #2614 found eight bypasses of the earlier denylist (attached option values, symlink then `..`, `@`/quoted spellings, credential stores missing from the list, recursive grep). Approving only what is proven safe removes that class instead of adding entries.

### Must not break

- A user's rules still win over the judge (`isPresetRule`). The judge's check runs before the tool; a path swapped for a symlink between the check and the tool call is the documented residual window (`docs/settings.md`).

## 2026-10-03 - Auto preset review fixes: attached option values, resolved credentials, user rule precedence

### What changed

- `auto-policy.ts`: a short-option word is checked at every tail that could be an attached value (`sort -o/x`, `-ro/x`, `cp -t/dir`, `make -C/dir -f/file -I/dir`, `unittest -s/dir`), the same as a separate argument. Credential checks run on the symlink-resolved target as well as the name, for shell arguments and for every path permission request (`read`, `edit`, `list`, `grep`, `external_directory`). An outside read is approved only when it resolves to no credential; outside `grep` only for a single regular file (the grep tool searches hidden files by default).
- `auto-credentials.ts`: adds agent `auth.json`, `.credentials.json`, `credentials.toml`, `.envrc`, `.terraformrc` and `credentials.tfrc.json`, shell history files, and `.m2/settings.xml`.
- `config.ts` + `service.ts`: `rulesForPreset` marks its rule objects (`isPresetRule`), and the judge's approval applies only to an ask that came from the preset's own rule, so a user's `bash=ask` or `external_directory=ask` after `auto` keeps asking.
- `auto-program-rules.ts`: `READ_ONLY_PROGRAMS` renamed `FILE_UTILITY_PROGRAMS` (it includes `mkdir`, `touch`, `cp`, `mv`).

### Why

- Review of record on #2614 found that attached option values and project symlinks to credentials bypassed the checks, and that the judge overrode a user's blanket ask rule.

### Must not break

- A user's rule always wins over the judge: deny, pattern-specific ask and blanket ask. `isPresetRule` relies on the preset's rule objects reaching `evaluate` unchanged (`merge` and the service only copy the array).

## 2026-10-03 - A failed permission setup blocks tools instead of skipping checks (#2617)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: `session_start` loads the permission rules (`loadPermissionRules`) inside a try/catch. When that throws (unknown `--permission-preset` or RPC `permissionPreset`, unknown or non-string settings `permissionPreset`), the error is recorded and rethrown as before, and `tool_call` refuses every call with `Permission setup failed: <reason>` until a later `session_start` succeeds. Applying deny rules to the active tool list (`applyToolDenials`) runs after and outside that guard: it calls extension action methods, which throw while the extension runtime is still starting, and that must not lock a session whose rules loaded fine.

### Why

- The extension runner reports a throwing handler and keeps the session running. The service was never created, and `tool_call` returned no decision when it was missing, so every tool ran unchecked: a misspelled preset turned the strictest setting into full access.

### Why an extension could not handle it

- The permission builtin owns tool-call gating; nothing after it can tell an unconfigured permission system from an allow.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: the `session_start` handler (now a wrapper around `startPermissionSession`) and the first lines of the `tool_call` handler.

## 2026-10-03 - Auto preset judges commands against a fixed policy

### What changed

- `types.ts`, `cli.ts`, `settings.ts`, `config.ts`: a sixth preset, `auto`, whose static rules match `accept-edits`. `PERMISSION_PRESET_NAMES` is the one list the flag, settings and error messages read. `loadPermissionSettings` also returns the effective preset (CLI, then project, then global, then the default).
- `auto-policy.ts`, `auto-shell-segments.ts`, `auto-program-rules.ts`, `auto-credentials.ts`: under `auto`, a bash command is split into simple commands (`;`, `&&`, `||`, `|`, newlines) and allowed only when every one is on the fixed program list, stays inside the project (paths resolved through symlinks, `cd` tracked) and touches no credential path. The splitter fails closed: substitutions, variables, escapes, subshells, groups, input redirects, here-docs, background jobs, globs in a program name, `~user`, and output redirects other than `/dev/null` all ask. Outside reads (read/grep/find/ls) are approved; a credential path asks even when a rule allows it.
- `service.ts`: `ask` takes `approveBlanketAsk` (approves an ask that comes only from a `*` rule, so a user's specific ask rule still asks) and `requireApproval` (asks even when a rule allows). Deny rules always win.
- `index.ts`: calls the auto judge only when the effective preset is `auto`.
- `../../../modes/rpc/session-command-router.ts`: advertises `permission_preset_auto`.

### Why

- desktop-fixall todo 39: an Auto mode that approves safe actions on the user's behalf and asks for the rest, judged by a fixed, reviewable policy rather than a model.

### Must not break

- `auto` is never the default. Every other preset behaves exactly as before. A command the judge cannot fully read asks; widening the program list or the splitter must keep the bypass tests in `test/permission/auto-preset.test.ts` asking.

## 2026-10-01 - Read shipped resources without approval (#2513)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: the read parser delegates to `read-permission.ts`, which uses the read tool's path resolver and canonical containment for shipped resources and outside paths.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: passes the read parser's internal prompt-suppression marker to the permission service; internal-tool allow-list policy is unchanged.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/service.ts`: evaluates every read rule, including explicit denies, before suppressing ask results for shipped resources. Permission request and approval-storage shapes are unchanged.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/evaluate.ts`: bundled read aliases (raw, normalized and canonical) are matched as one target with the existing last-rule precedence, preserving relative-path and resolved-symlink denies as well as later explicit allows.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/external-dir.ts`: shares the existing parent-directory approval pattern logic with the read parser and keeps filesystem-root targets scoped to their individual file on every platform.

### Why

- Bundled skill reads were classified as external directories, and ask-first also requested read approval. Symlinks escaping the shipped payload and writes must retain their normal permission policy.

### Why an extension could not handle it

- The permission builtin owns classification before the actual read tool executes.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: imports and the read parser only; no internal-tool allow-list changes.

## 2026-10-01 - Internal harness operations do not require approval

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/internal-tools.ts` defines the engine-owned bookkeeping and observation tool set.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts` preserves these tools during startup filtering and exempts only no-parser fallback requests and monitor rearming. Command and file monitors keep their normal checks. Every explicit tool-owned parser request remains enforced, including a scoped request named after the tool.

### Why

- Internal bookkeeping stopped desktop turns on approval cards in command-asking modes. Preset entries alone could be overridden by user rules and disable the tools again.

### Why an extension could not handle it

- The permission builtin owns active-tool filtering and the approval decision before tool execution.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: session-start filtering and the tool-call request parsing boundary.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/internal-tools.ts`: fixed internal-tool classification.

## 2026-09-27 - Tools classify their own calls with `permissionParser`

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: `ParserRegistry.has()`, and `toolOwnedPermissionRequests()`, which reads a tool's `permissionParser` from `pi.getAllTools()`.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: `tool_call` uses the built-in parser when one exists, else the tool's own parser, else the single request named after the tool.

### Why

- An extension tool can expose read and exec tiers (for example `my_tool:exec=deny`), resolved per session from the session's own tools. A tool can never replace a built-in parser.

### Why an extension could not handle it

- The permission-system builtin owns parsing.

### Expected merge conflict zones

- LOW: the parse call at the top of the `tool_call` handler.

## Overview
Full port of opencode's permission system to senpi-mono as a builtin extension.

## Files
- `types.ts` - Core type definitions (Action, Rule, Request, Reply, etc.)
- `evaluate.ts` - Rule evaluation engine with wildcard matching
- `arity.ts` - Bash command arity parser
- `config.ts` - Config transforms (fromConfig, merge, disabled)
- `storage.ts` - JSONL persistence layer
- `external-dir.ts` - External directory detection
- `service.ts` - Permission service core (ask/reply/list)
- `events.ts` - Event system (permission_asked/replied)
- `parsers.ts` - Tool input parser registry
- `internal-tools.ts` - Engine-owned bookkeeping tool classification
- `prompt.ts` - TUI permission prompt
- `non-interactive.ts` - No-UI fallback handler
- `settings.ts` - settings.json integration
- `cli.ts` - CLI flag parsing
- `index.ts` - Extension entry point

## Why Builtin Extension?
Following pi-mono's extension-first philosophy. All permission logic is in the extension, zero core tool modifications.

## 2026-09-07 - monitor path parser derives the approved parent without realpath

### What changed

- `parsers.ts` monitor parser: the approved-parent identity for a `monitor` `path` is now `realpathWithoutOpen(dirname(resolve(cwd, path)))` (shared walker in `src/utils/paths.ts`) instead of `fs.realpathSync(...)`, and the surrounding try/catch is gone because the walker never throws (a missing parent is kept verbatim; registration still performs the authoritative `access` check).
- `external-dir.ts` imports the same shared walker; its private `normalizePath` copy moved to `src/utils/paths.ts` unchanged so every main-thread path resolution uses one implementation.

### Why

- The `tool_call` hook runs on the host main thread, and the 2026-09-06 fix only covered the command tokenizer. `monitor({ path })` still hit `fs.realpathSync` on the parent directory; Bun's realpath `open(2)`s every directory it resolves, so a path under a wedged autofs trigger (`/home/x.log` on a macOS host whose automounter never answers) froze the whole TUI exactly like #1416.
- The registry (`terminal/monitor-registry.ts`) compares this approved parent byte-for-byte with its own resolution, and Bun's realpath canonicalises case (`/users/X` -> `/Users/X`), so both sides had to switch to the same walker in one change; see `terminal/changes.md` (2026-09-07).

### Expected merge conflict zones

- `parsers.ts` monitor parser registration block (`registry.register("monitor", ...)`) and its `node:fs` import.
- `external-dir.ts` import block (the walker body left this file).
- `test/permission/monitor-parser-parent.test.ts` (new: approved parent with realpath denied, relative path, symlinked parent, execute-only parent).

## 2026-09-06 - external-dir path normalization never opens path components

### What changed

- `external-dir.ts` `normalizePath()` resolves symlinks with a component walker built on `fs.lstatSync` + `fs.readlinkSync` (bounded by `MAX_SYMLINK_HOPS`), keeping components from the first missing one onward verbatim. It replaces the `fs.realpathSync` walk-up that climbed a non-existent path to its nearest existing ancestor.

### Why

- `extractExternalPaths()` runs inside the `tool_call` hook on the host main thread for every `bash`/`monitor` command. Bun implements `fs.realpathSync`, `realpathSync.native`, and `fs.promises.realpath` by `open(2)`-ing the path, so a command that merely mentioned `/home/user/work/x` (a path on a remote Linux box) climbed to `realpathSync("/home")`, an autofs trigger on macOS; the wedged automount never returned and the whole TUI froze (senpi #1416). The same open-based resolution fails with EACCES on execute-only directories, so files under them inside the project were reported as external.
- `lstat` needs only search permission and never triggers a mount; this is what realpath(3) itself does.

### Expected merge conflict zones

- `external-dir.ts` `normalizePath` body.
- `test/permission/external-dir-resolution.test.ts` (new file: filesystem-backed `isExternalPath` cases — symlinked cwd, execute-only directory, symlink escape, symlink loop; the symlinked-cwd case moved here from `external-dir.test.ts`).

## 2026-08-21 - Fix unhandled rejection on session shutdown with pending permissions

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: attached immediate rejection catch handler to `service.ask(request)` promise during `tool_call` so that when `session_shutdown` rejects pending permission requests (or cascade rejection occurs), no unhandled promise rejection or `uncaughtException` is triggered while the prompt is pending.

### Why

- When a session is cleared (`/clear`), reloaded, or terminated while a tool permission prompt is pending, `session_shutdown` rejects all pending permission requests with `RejectedError`. Previously, `askPromise` was floating without an attached `.catch()` handler until after the UI prompt resolved, causing Node.js to fire an `unhandledRejection` event that crashed interactive mode via `uncaughtException`.

### Why this belongs in the builtin extension

- External extensions cannot observe or attach a rejection handler to `PermissionService`'s private request promise. The permission-system builtin owns that promise and the `tool_call` / `session_shutdown` lifecycle, so it must attach the handler immediately when creating the request.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts` `tool_call` event handler.

## 2026-06-23 - permission presets

### What changed and why
- Added `permissionPreset` settings and `--permission-preset` CLI support with `full-access` as the default.
- Added `workspace`, `read-only`, and `ask` presets that mask lower-precedence wildcard allows before applying their own policy.
- Kept approved JSONL storage unchanged; session approvals still load separately after static rules.

### Files modified
- `types.ts`
- `config.ts`
- `cli.ts`
- `settings.ts`
- `index.ts`

### Expected merge conflict zones
- `settings.ts` merge order if upstream changes settings precedence.
- `config.ts` preset rule definitions if upstream adds default permission policy.
- `index.ts` extension flag registration if upstream moves permission flags into core args.

## 2026-05-11 - Local wildcard matcher

### What changed and why
- Moved the wildcard matcher into `permission-system/wildcard.ts` so permission evaluation owns its matching logic locally.
- Added focused wildcard regression coverage under `test/suite/permission-system-wildcard.test.ts`.

### Files modified
- `evaluate.ts`
- `wildcard.ts`

### Expected merge conflict zones
- `evaluate.ts` imports if upstream also changes rule matching.

## 2026-04-13 - apply_patch path extraction

### What changed and why
- Extended `apply_patch` permission parsing and request metadata extraction to read file paths from patch bodies (`input` / `patchText`) instead of falling back to wildcard edit permissions.
- This change was required once GPT sessions started using `apply_patch` instead of `write` / `edit`; otherwise permission prompts and approvals would lose per-file scope.

### Files modified
- `parsers.ts`
- `index.ts`

### Expected merge conflict zones
- `parsers.ts` edit-tool parsing logic
- `index.ts` request metadata extraction

## bash_input gated as bash-class command execution (2026-07-07)

- `parsers.ts`: the persistent-terminal `bash_input` tool writes arbitrary stdin to a live
  shell = arbitrary command execution, so it is parsed off its `input` field into the SAME
  `bash` permission class (shared `parseBashLikePermission` helper). Otherwise read-only/ask
  presets would be bypassable by steering a background session. `kill_bash`/`bash_resize`/
  `bash_output` fall back to their own tool-named (session-control/read) permissions.
## 2026-09-30 - Edit-only project preset (senpi#2430, DESKTOP-55)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/config.ts`: accept-edits starts with a wildcard ask reset, allows read/list/grep/edit, asks bash and external_directory, and exports its host capability name.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/types.ts`, `cli.ts`, `index.ts`, `settings.ts`: accept-edits is accepted in settings/CLI and documented by flag help and validation guidance. Settings tests assert acceptance/rejection behavior rather than the validation sentence.

### Why

workspace allows bash. A client promising automatic project edits and command confirmation needs a separate preset.

### Why an extension could not handle it

The permission-system builtin owns preset policy and parsing; all policy remains in this extension.

### Expected merge conflict zones

Preset union, CLI switch and rules table. Existing workspace semantics and approval storage remain unchanged.

## 2026-10-04 — A permission request records and sends its tool call (#2710)

**What:** `index.ts` sets `Request.tool = { callID: event.toolCallId, parentCallID? }` (the field existed and was never set; `messageID` becomes optional because the hook has none). `prompt.ts` passes the call to `ctx.ui.select` and to the feedback `ctx.ui.input` as `{ toolCallId, parentToolCallId? }`.

**Why:** clients bind each prompt to its call; see `modes/rpc/changes.md`.

**Test:** `test/suite/regressions/issue-2710-permission-tool-call-id.test.ts`. Three reads in one message, over the real host core: each prompt carries its own call id. Answering "Allow once" per prompt returns each call's own file.
