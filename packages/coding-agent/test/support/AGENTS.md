# test/support

## OVERVIEW

Test-environment and provider-wire support, separate from session scenario harnesses. Score 9 - distinct setup/build boundary; `assertWorkspaceBuildPrerequisite` has 29 AST reference nodes.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Ambient override quarantine | `quarantine.ts` - `resolveQuarantineAgentDir`, `scrubAmbientAgentDirEnv`; contract documented in parent |
| Unique agent/log writer directory | `temp-agent-dir.ts` - `createTempAgentDir` |
| Child workspace import/build check | `workspace-build-prerequisite.ts` - `assertWorkspaceBuildPrerequisite`, freshness/resolution probes |
| OpenAI text-tool recovery over SSE | `openai-recovery-wire.ts` - captured requests, fragmented frames, complete/truncated scenarios |
| Anthropic text-tool recovery wire | `anthropic-recovery-wire.ts` |
| Claude OAuth test-provider setup | `claude-sdk-oauth-provider.ts` |

## CONVENTIONS

- Build checks are opt-in at the top of dist-dependent test files, not in global `test/setup.ts`.
- Vitest aliases workspace imports to source; spawned Node/tsx children instead follow package `exports` into `dist`. A passing in-process import does not establish the child prerequisite.
- Resolution probes use ESM `import.meta.resolve`, then check that the target exists; resolving a URL alone does not prove a build exists.
- Freshness checks cover ai, agent, tui, pty, protocol, and client. They compare source/dist mtimes, independently of Vitest's aliases.
- Linked-worktree checks consider both the hoisted workspace symlink's real package root and the checkout-relative package root. Either stale tree can break child imports.
- `createTempAgentDir` uses `mkdtemp`; its caller-supplied prefix is a label, not the uniqueness mechanism. Returned roots are left for OS cleanup by this helper.
- Provider-wire recovery fixtures expose real loopback HTTP/SSE boundaries and explicit deferred observations, including fragmented frames and truncated tool calls.

## ANTI-PATTERNS

- Do not make workspace build assertions global: the terminal-tools CI subset intentionally runs without a workspace build.
- Do not replace ESM resolution probes with `require.resolve`; import-only export maps would produce false missing-package reports.
- Do not hardcode shared `/tmp` agent/log paths. Compaction loggers still write and rotate real files even when a sink is injected.
- Do not hide stale-dist failures with a mocked import or skip; the prerequisite error names the missing build and its repair command.

## COMMANDS

From the repository root, `npm run build` satisfies the workspace-build prerequisite. Run the owning test file afterward using the parent guide's package runner; these support modules are not standalone test entries.
