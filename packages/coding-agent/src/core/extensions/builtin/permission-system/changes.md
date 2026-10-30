# Permission System Builtin Extension

## 2026-10-26 - Retain resolved external-directory targets (senpi#4351)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/external-dir.ts`: return the symlink-resolved external target and compare directory device/inode identities for case-alias containment, including missing descendants.
- External rules and remembered scopes now compare their existing literal prefix by device/inode without opening directories or folding case; trailing-slash directory approvals retain the resolved directory scope rather than granting its parent (binding review H1/H2).
- `packages/coding-agent/src/core/extensions/builtin/permission-system/external-pattern.ts`: verify case aliases after wildcards by component device/inode, preventing glob-deny bypasses while preserving exact case for distinct or missing targets and synchronous no-open matching (binding review H1-GLOB).
- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts` and `packages/coding-agent/src/core/extensions/builtin/permission-system/read-permission.ts`: use that target for external request patterns and remembered scopes.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/types.ts`, `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`, and `packages/coding-agent/src/core/extensions/builtin/permission-system/service.ts`: carry lexical spellings separately for display and copy them when listing pending requests.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/prompt.ts`: show the resolved target alongside its original spelling, without trusting caller-supplied directory metadata or truncating literal stars.
- Review fold: external-directory rules retain last-match-wins separately for absolute lexical, on-disk case-canonical, and resolved spellings, then take the most restrictive decision. Directory listings and device/inode checks preserve lexical ancestry across case aliases and wildcards before symlinks; raw display paths never affect policy, and remembered scopes stay resolved. Filesystem identity lookups remain evaluation-local, and prompts list every resolved target.
- Resolution-chain review fold: branch between keeping and following every symlink, preserving intermediate spellings with a 16-spelling/40-hop limit that asks on exhaustion or loops. Component `lstat` identities retain case equivalence below non-listable ancestors without merging distinct symlink routes. Case recovery and directory listings are cached only within one decision; multi-path denials report only the target belonging to a denied alias. Document the intentional difference between a resolved-only configured allow and remembered "Always".
- Dot-target review fold: normalize followed link targets against their containing directory before storing or walking the absolute spelling, closing intermediate-deny bypasses through `.`, `..`, and `../..`. Refuse new spellings over the bound before case-recovery directory reads. Cover relative-target rule precedence and document that a genuine intermediate spelling's blanket deny can still win when both endpoints allow.
- Physical-walk review fold (supersedes the branching and lexical normalization above): traverse a component queue from a fully resolved position, applying `..` only to its physical parent and prepending raw link targets. Retain the absolute request, actual physical-prefix symlink routes, final path, and case forms; never synthesize relative targets under unresolved lexical parents. Enforce the 16-spelling bound before every insertion, including case forms, and retain the 40-hop fail-closed limit. Cover absolute/relative `S/..` deny bypasses, phantom-parent false denies, and the linear walk's exact spelling boundary.
- Wildcard-suffix identity review fold: prove component case equivalence with lexical `lstat` identity, not the followed target, so distinct case-sensitive symlink entries sharing a destination cannot override each other's deny or cause a false denial; retain true case aliases and non-listable-ancestor handling.

### Why

- Classification resolved symlinks but rule evaluation and saved approvals still used the alias, allowing an alias approval to miss a deny on the actual target. Case-preserving string comparison also treated an internal case alias as external. Part of #4311.

### Why an extension could not handle it

- The builtin parser, classifier, and request renderer own the identity that reaches permission evaluation and approval persistence.

### Expected merge conflict zones

- `external-dir.ts` containment, `parsers.ts` external-request construction, `read-permission.ts` external reads, `index.ts` request construction, `types.ts` request fields, `service.ts` defensive copies, and `prompt.ts` external-directory display.

## 2026-10-26 - A refusal is final for what the refused call was meant to do (senpi#4321)

### What changed

- `types.ts`: `RejectedError`, `CorrectedError` and `DeniedError` keep their first sentence, which clients match as a prefix, and then add the rule (`DENIAL_IS_FINAL`, built on `NO_OTHER_ROUTE`). The model must not get the same result another way (another tool, command, path or host), tells the user what was refused, and continues only with work that does not depend on it. With feedback, the model follows the feedback first.
- `non-interactive.ts`: a no-UI refusal says the call did not run, carries the same rule, and frames the `--permission` override as the user's action.
- `index.ts`: the deny provenance suffix says the user can edit the rule, instead of telling the model to edit it.

### Why

- "This specific tool call" read as permission to reach the refused result through a different tool. The provenance suffix told the model to edit its own permission rule.

### Why an extension could not handle it

- These texts are the permission builtin's own refusal results; another extension cannot rewrite them.

### Expected merge conflict zones

- `types.ts` (the three error constructors), `non-interactive.ts` (`handleNoUI` message).

## 2026-10-27 - external_directory classifies the path the tool opens (senpi#4311)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: `withExternalDirectoryRequests` maps each raw argument through the resolver its tool uses before classifying it (write/edit/ls/find/glob: `resolveToCwd`; apply_patch: `resolvePatchPath`; grep: `resolveToCwd` with the same existing-literal-name-first, missing-name/file-prefix selector fallback as the tool; `multiedit`: raw and resolved; monitor: raw). grep `path` arrays are classified element by element. Each opened path then goes through `resolveExternalPath` (the senpi#4351 canonical spelling walk, still the source of truth); the lexical rule alias is taken from the opened path, and `originalPaths` keeps the raw argument. Patterns and Always scopes are de-duplicated by canonical target, while the rule aliases are merged (in order, without duplicates) from every opened spelling, so a rule on a symlink spelling still applies when the same call names the real path first.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/prompt.ts`: the external-directory prompt uses only the resolved request target, ignoring caller display metadata and preserving literal filename characters.
- Review fold: selector-shaped grep paths use synchronous stat probes to preserve the synchronous dispatch fence; only ENOENT permits fallback. Tests cover literal names, non-file prefixes, spoofed display metadata, literal `*`, and platform-specific file-URL/UNC behavior.

### Why

- The check classified the raw text while the tools open the normalized path, so `@/abs/x`, `file:///abs/x`, Unicode-space spellings and grep arrays or line selectors reached files outside the workspace with no `external_directory` ask under the narrower presets.

### Why an extension could not handle it

- The parser registry is the permission system's own input to every decision (tool_call hook and codemode dispatch); an extension cannot replace a builtin parser.

### Expected merge conflict zones

- LOW: `parsers.ts` parser registrations and the external-directory branch of `prompt.ts` (fork-only permission system).

## 2026-10-26 - bash permission: evaluate every command segment (senpi#4317)

### What changed

- `bash-command-segments.ts` (new): `analyzeBashCommand(command)` lexes a command the way bash splits it. It returns each simple command the command would run as normalized words, or `unparsed`. It covers `;`, `&&`, `||`, `|`, `|&`, `&` and line breaks; subshells and brace groups; the bodies of `$( … )`, backticks, `<( … )` / `>( … )`, `${ … }` and `$(( … ))`; unquoted here-document bodies; `if`/`while`/`for` bodies; and `[[ … ]]`. Redirections and their targets are dropped. A command name is normalized: leading assignments and reserved words are skipped, and a path becomes its basename. A wrapper (`env`, `command`, `exec`, `builtin`, `nohup`, `time`, `nice`, `timeout`, `stdbuf`, `caffeinate`, `xargs`, `sudo`, `doas`, `eval`, `trap`, `su -c`, `bash`/`sh`/`zsh`/`dash`/`ksh -c`, `find -exec`) yields its own name and the command it runs, recursively. The command becomes `unparsed` on an unterminated quote, `case`, a function definition, a command name built by an expansion, a glob or brace expansion, or an option a wrapper table does not list.
- `parsers.ts`: the `bash` request carries one pattern per command, its `BashArity` prefix. The same request serves `bash_input`, command `monitor` calls and nested `tool.bash`. The service already requires every pattern to be allowed and refuses on any deny, so the call is as strict as its strictest command. "Allow always" stores exactly those prefixes (`<prefix>` and `<prefix> *` for each). An unparsed command becomes one target, `(unparsed) <command>`, that only a `*` rule (a preset or a blanket setting) can decide, so no single-command grant allows it. Before that target, a deny-only request (`autoApproveAsk`) checks the command's plain words against deny rules.
- A simple command keeps the single pattern it had before.
- Limits fail closed: a command longer than 64 KiB, nesting deeper than 12 levels, a lexer step budget overrun, or any error inside the lexer makes the command `unparsed`. Best-effort deny candidates use at most three words each, so their work grows linearly with the command.
- "Allow always" never stores a target that holds its own `*` or `?` (stored rules are matched as globs, so such a target would widen into a wildcard). That call is allowed once. Request patterns stay raw, so existing allow and deny rules match exactly as before.

### Why

- The decision used only the first command's prefix. The rest of a compound or wrapped command was never judged against the user's rules or grants.

### Why an extension could not handle it

- This builtin's parser registry produces the patterns a call is decided on. Another extension cannot change the requests the permission service evaluates.

### Expected merge conflict zones

- `parsers.ts` (`parseBashLikePermission`, `bashCommandRequests`).

## 2026-10-16 - A wider "Allow always" for tools without a parser (senpi#3403)

### What changed

- `always-scope.ts` (new): `widerAlwaysScope(toolName, argKey, arg)` returns the extra option a prompt may offer when the request came from the fallback parser (a tool with no parser of its own):
  - a URL argument gets its DOMAIN, "Allow <tool> on <host> always in this project". The grant is ONE literal, `origin=<canonical origin>`, matched by equality. `canonicalUrlOrigin` gives the scheme, the parser's lowercased punycode host, and the port only when it is not the default; no userinfo. A domain origin is given only for raw text every parser reads as the same host: a strict `http(s)://<ASCII DNS host>[:port]` prefix followed by `/`, `?`, `#` or the end; no backslash, `@`, `%`, whitespace or control character anywhere; no IPv6 literal, trailing dot or non-ASCII host; and the same host and port as `new URL()`. Anything else gets no alias and no domain option, so it asks. #3416 review: `https://*/a` became `https://*` and allowed any site; `https://example.invalid\@evil.test/` is example.invalid to WHATWG and evil.test to curl and Python. A parser-less tool parses the URL itself, so the permission layer cannot make it reuse one parse.
  - a free `input`/`pattern` argument gets the tool, "Allow <tool> always in this project", with pattern `*`;
  - a command or a path gets nothing wider, and built-in tools never do.
- `parsers.ts`: the fallback records which argument it used and attaches `widerAlways`. A URL request is decided against `[raw URL, origin=<canonical origin>]` (`ruleAliases`), so the grant applies to every spelling of the origin, and a rule on the raw URL (a deny included) still matches it.
- `prompt.ts`: the option appears after "Allow always" and replies `always` with the wider patterns.
- `service.ts` and `index.ts`: the reply's patterns become the session's approvals and are persisted to the agent-dir store, so other open sessions of the project stop asking too.

### Why

"Allow always" stored only the exact argument, so a browser or MCP tool asked again for the next URL or input (sisyphuslabs/omo-desktop-app#2465). A tool-wide allow for a browser would mean "go anywhere", so URLs are scoped to their domain.

### Why an extension could not handle it

The prompt, its options and the stored approvals belong to this builtin's decision path; another extension cannot add an option to a permission prompt or write this store.

### Expected merge conflict zones

`prompt.ts` (the option list and reply mapping), `parsers.ts` (`fallbackPermissionRequestFor`), `types.ts` (`Request`, `ReplyInput`).

### Must not break

`test/permission/tool-scope-allow-always.test.ts`:
- the same domain stops asking; a look-alike, `@` or port variant asks again;
- a second open session stops asking;
- a free-input tool is allowed tool-wide;
- a command-shaped tool gets no wider option;
- `*`, `?` and `[` hosts get no domain option;
- uppercase, `:443`, userinfo and IDN spellings match the grant, while another port or a host named only in the path does not.

## 2026-10-16 - The legacy approvals import keeps pre-store answers (#3301 review round 2)

### What changed

- `storage.ts`:
  - `readRules(path, requireSource)`: the one-time import of `<cwd>/.senpi/permissions-approved.jsonl` still requires an allow, a concrete permission and a well-formed pattern, but not the `source` marker. Store reads keep requiring the marker.
  - A failed import removes the partial store and marker, so the next load retries.
  - The legacy file is deleted only when every line was imported; a file with a refused line stays on disk (the marker keeps it from being read again).
  - The comments no longer call the marker a security boundary.
- `service.ts`:
  - `canonicalForCompare` resolves a path that does not exist yet through its nearest EXISTING ancestor's real path at any depth, plus the missing tail, so the agent cannot create the store (or its directories) before the first answer is written (round-3 LOW: one level up missed a store whose directories were absent).
  - The user-rule filter is computed once.

### Why

senpi never wrote a `source` field before the store moved. Requiring it made the import keep nothing, write an empty store and delete the legacy file, silently losing every saved "Always" answer.

### Must not break

`test/permission/approved-store-security.test.ts`:
- "migrates a pre-PR approval line, which never carried a source marker, and keeps it working";
- "never deletes a legacy file it did not fully import";
- "refuses a write to the store even when its directories do not exist yet";
- the forgery case drops only the wildcard permission and non-allow lines;
- the forgery test file's symlink and post-migration-plant cases.

## 2026-10-15 - A named deny keeps the model's do-not-retry sentence (#3301)

### What changed

- `index.ts` `denyReason`: the refusal that names the settings rule now starts with the DeniedError's own sentence ("The user has specified a rule which prevents you from using this specific tool call.") and then names the rule and its layer. Replacing that sentence dropped the model's cue not to retry the call.
- Tests updated to this PR's rules:
  - `final-qa` S3/S4/S7 and `codemode-bridge` name a prompting preset, because the full-access default never prompts;
  - S3 reads the agent-dir approved store;
  - the P0 host writes global settings into the session's own agent dir.
- `rpc-host-handover-permission-preset.test.ts`:
  - `probeTurn` drops replayed records, so its loops can no longer spin and OOM;
  - prompt answers carry `sessionId`;
  - `open_session` retries the documented `session_path_in_use` while a predecessor parks;
  - the fake model decides on the latest message only (the senpi#3363 false alarm).

### Must not break

`issue-2513-bundled-read-permissions` and `final-qa` S2 assert the do-not-retry sentence; `deny-reason-precedence` asserts the named rule.

## 2026-10-15 - The enforced preset is readable per session (#3301)

### What changed

- `preset-registry.ts`: a `WeakMap` keyed by `sessionManager`, like the dispatch authorizers. `registerPermissionPresetReader` returns a retire function that never removes a newer load's reader.
- `index.ts`: `session_start` registers the reader before loading the rules, so a failed load reports `undefined` instead of an older load's preset. The reader runs `followPresetFlag(ctx.cwd, ctx.agentDir)` first, then returns `activePreset` unless `setupError` is set. `session_shutdown` retires it.

### Must not break

`test/suite/regressions/issue-2465-get-permission-preset.test.ts`:
- settings-only Full access and the no-flag default both read `full-access`;
- a setting's stricter preset is read as that preset;
- a live flag change is followed;
- a failed setup reads `undefined`, and so does a session without the permission system.

## 2026-10-14 - Unregistered-tool deny never masked; configured deny beats a preset wildcard (#3301 review)

### What changed

- `parsers.ts`: the unknown-tool fallback collapsed to a bare `"*"` target, so a pattern-specific configured deny (e.g. `my_tool: {"rm *": deny}`) could not match an unregistered tool and the decision widened to the preset. The fallback now derives the decision target from the tool's meaningful arg (path/command/url/input), keeping `"*"` only for a truly arg-less call.
- `service.ts` (plain path): a preset's wildcard-ask (e.g. a CLI `ask` preset, merged after project rules) masked an explicit settings/CLI deny in last-match order. The user's configured (non-preset) rules are now evaluated with their own last-match order first; a user deny wins outright, and the preset only fills the gap the user left. The presetBound path already applied this split.

### Why

- An unregistered (custom/MCP) tool whose deny named a pattern was not denied at all — the call executed under the preset's wildcard, the same fail-open class as the forged-approval finding.
- A CLI `ask` preset's wildcard, landing after a project deny, made the decision `ask` instead of `deny`, so a configured deny was prompted instead of refused.

### Why an extension could not handle it

- Both live in the parser registry's fallback and the service's single decision point; an extension cannot intercept either.

### Expected merge conflict zones

- `parsers.ts` `fallbackPermissionRequestFor` / the registry's no-parser branch; `service.ts` the plain-path user-rule split in `dispatchDecision`.

## 2026-10-14 - Approvals-store security hardening (#3301 review / #2465)

### What changed

- `storage.ts`: the approved store moved out of the workspace to `<agentDir>/permissions/approved/<project-hash>.jsonl`, keyed by the project's real path, so an agent can no longer write `<cwd>/.senpi/permissions-approved.jsonl` and have it honored in the same session. Loaded lines are validated (action `allow` only, a concrete non-wildcard permission, a well-formed pattern, and a `user-answer` source marker only the answer path writes); anything else is dropped. The legacy in-workspace file is imported once, validated, then removed — a line planted there later is never honored. Reads and appends never follow a symlink at the store path.
- `service.ts`: `dispatchDecision` evaluates the configured ruleset alone first; a configured (global/project/CLI) deny outranks any approval in both the plain and presetBound paths, so an approved `allow` can only turn a configured ask into an allow, never a deny. A defence-in-depth deny on the store's real path (case-folded on macOS) keeps the agent's own tools from touching it whatever the rules say. The session-owned approved suffix is exposed by identity (`getSessionApproved`), not by a load-time index.
- `index.ts`: a failed `persistAlways` write is caught and logged (the tool call proceeds) and the shutdown append retries it; the shutdown append uses `getSessionApproved` so a concurrent session's append is not duplicated and a deleted store does not resurrect or drop this session's answers. `denyReason`/`findDenyProvenance` now name the rule that actually decided, using the same global→project→CLI last-match precedence as the decision and all of the request's patterns, and only promise "edit that entry to allow" when no other layer still denies.
- `settings.ts`: approvals load from the agent-dir store.

### Why

- A model or prompt injection could previously write a forged `{"permission":"*","pattern":"*","action":"allow"}` line into the in-workspace store and have it honored on the very next call, mid-session — a same-session privilege escalation.
- An approved `allow` could override a configured settings `deny`, live, disabling a user policy such as `bash: {"rm -rf *": deny}`.
- Index-based shutdown bookkeeping duplicated or dropped approvals once the store refreshed; a failed write aborted an already-answered tool call.
- The refusal named the first matching layer, not the layer that actually decided, and could tell the user to edit an entry whose removal would not unblock the call.

### Why an extension could not handle it

- The store location, line validation, decision precedence, and shutdown persistence all live in the permission service's single decision point and its storage contract; an extension outside `permission-system` cannot intercept them.

### Expected merge conflict zones

- `storage.ts` store path / validation / migration; `service.ts` `dispatchDecision` precedence and `getSessionApproved`; `index.ts` `denyReason`/`findDenyProvenance` and the shutdown append; `settings.ts` `loadApproved` call.

## 2026-10-14 - Full-access central decision + cross-session approvals (#2465)

### What changed

- `service.ts`: `dispatchDecision` now applies the dedicated full-access decision — when the active preset is `full-access`, an `ask` result collapses to `allow` while a `deny` stays denied — so a settings/CLI `ask` rule can never re-introduce a prompt under Full access. The service takes the active preset at construction for this.
- `service.ts`: the approved store is re-read per decision when its mtime+size changed (`refreshApproved`), replacing only the persisted prefix and keeping this session's own answers, so an "Always" answer one open session writes takes effect on another open session's next decision.
- `storage.ts`: adds `approvedFileVersion` (mtime+size) for the cheap change check behind that re-read.
- `index.ts`: passes the active preset and the session cwd into the service; persists each "Always" answer at answer time (`persistAlways`) instead of only at session shutdown, and the shutdown append skips rules already persisted so the JSONL contract keeps one line per rule.
- `index.ts`: permission loading now uses the session's own `agentDir` (`ctx.agentDir`) at `session_start` and on every `followPresetFlag` reload, so global settings a host session actually runs with are honored; a denial's block reason names the matching rule and its layer (global/project/CLI) via `denyReason`.
- `settings.ts`: no longer re-appends the CLI `full-access` preset's wildcard allow (redundant with the default), which had masked a user's explicit settings deny.

### Why

- Under Full access nothing may prompt, and a mode change must apply immediately to running and idle sessions; a settings `ask` rule was silently prompting, and a settings `deny` was silently allowed.
- An "Always allow" answer must reach other open sessions of the same project at once, not only after their next session start.

### Why an extension could not handle it

- The decision lives in the permission service's single decision point and the approved store's read path; an extension outside `permission-system` cannot intercept either without replacing the evaluator and storage contract.

### Expected merge conflict zones

- `service.ts` `dispatchDecision` / `refreshApproved` and the constructor signature; `index.ts` `authorizeToolCall` block reasons, `loadPermissionRules` signature, and the shutdown append; `settings.ts` `loadPermissionSettings` merge order; `storage.ts` approved-store helpers.

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
