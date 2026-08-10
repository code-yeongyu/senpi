# General extension-registered filesystem access policies

## Summary

This change adds a public, extension-registered filesystem access policy API for Senpi's built-in file tools.
Extensions can now make canonical-path decisions for read, enumeration, and write operations at the final tool execution
boundary, below permission and approval hooks.

The implementation is general infrastructure. It contains no product-, agent-, memory-, or identity-specific policy.

## Motivation

The existing `tool_call` hook can block or rewrite a tool call, but it runs before built-in tools resolve the target path.
That makes it unsuitable for policies that must reason about real symlink targets or missing write targets through their
nearest existing parent. It also belongs to the permission/approval pipeline, so it is not the right enforcement point
for a policy that must remain active in unrestricted approval modes.

Extensions should own policy decisions. Core should provide only registration, composition, canonicalization, and a
non-bypassable executor seam.

## Public API

```typescript
export type FilesystemOperation = "read" | "enumerate" | "write";

export interface FilesystemPolicyRequest {
  operation: FilesystemOperation;
  canonicalPath: string;
  toolName: string;
}

export type FilesystemPolicyDecision =
  | { allow: true }
  | { allow: false; reason: string };

export interface FilesystemPolicy {
  check(
    request: Readonly<FilesystemPolicyRequest>,
  ): FilesystemPolicyDecision | Promise<FilesystemPolicyDecision>;

  // Metadata reserved for future inherited process sandbox support.
  deniedRoots?: readonly string[];
}

pi.registerFilesystemPolicy(policy);
```

`registerFilesystemPolicy()` is factory-time only. Extension factories run again on reload, so the policy set is rebuilt
with the rest of the extension runtime.

### Operation mapping

| Operation | Built-in tools |
|---|---|
| `read` | `read` |
| `write` | `write`, `edit` |
| `enumerate` | `ls`, `find`, `grep` |

## Enforcement semantics

- Existing targets are canonicalized with `realpath`.
- Missing targets are canonicalized through the nearest existing real parent, with the unresolved suffix reattached.
- Dangling symlink targets are followed before the missing suffix is resolved.
- The policy is checked immediately before the built-in tool's target I/O. Write and edit checks run inside the existing
  per-file mutation queue.
- Policies execute in extension load order and registration order. The first denial wins.
- A denial throws a normal tool error whose message is the policy reason. A thrown policy error also fails closed before
  target I/O.
- Permission and approval hooks still run normally, but an allow decision there cannot bypass the executor policy.
- Extension-overridden or custom tools are not silently wrapped. They remain responsible for their own filesystem
  policy, avoiding false assumptions about arbitrary tool semantics.
- When no policy is registered, composition returns `undefined`. Each built-in executor performs one checker null test
  and otherwise follows its previous path without canonicalization or extension dispatch.

## Design decisions

### Policy object rather than another event

A registered policy is a stable capability, not a lifecycle notification. Keeping it separate from `tool_call` avoids
mixing canonical filesystem enforcement with argument mutation, UI approval, and hook-result composition.

### Required denial reason

A denied decision requires a reason so the ordinary tool error is actionable and no generic permission-layer wording
replaces extension policy context.

### Denied-root metadata is declarative only

`deniedRoots` is retained on the loaded policy and aggregated by `ExtensionRunner`. Built-in file tools do not infer
policy behavior from it; `check()` remains authoritative. This leaves a low-conflict metadata seam for a future
capability-gated shell sandbox without pretending metadata alone is enforcement.

## Deliberately excluded: Bash sandbox inheritance

Bash inheritance was not implemented in this change.

The current low-level seam, `BashSpawnHook`, can rewrite only `command`, `cwd`, and `env` before `BashOperations.exec`.
Senpi has no OS-sandbox abstraction, platform capability probe, or executable/argv wrapper contract that can translate
arbitrary denied roots into inherited restrictions. Prefixing a visible shell string with `sandbox-exec`, `nono`,
`bwrap`, or similar tooling would be quoting-sensitive, platform-specific, and incomplete. It would also miss or diverge
from replacement Bash implementations such as the persistent-terminal extension and custom/remote `BashOperations`.

A correct implementation would need a separate capability-gated sandbox backend shared by the default Bash launcher,
persistent terminal processes, and descendants, including explicit runtime/temp-path carve-outs and platform-specific
failure behavior. That is materially more invasive than this API and should be reviewed independently. This PR keeps
`deniedRoots` metadata and `ExtensionRunner.getFilesystemPolicyDeniedRoots()` available for that future work.

## General sample consumer

The test suite includes an extension that permits writes only inside its own workspace root. It proves that:

- an approval hook returning `{ block: false }` does not bypass the policy;
- `pi.executeTool("write", ...)` receives the policy error and does not create the denied file;
- model-dispatched `write` receives the same normal tool error; and
- a write inside the allowed root still succeeds.

This consumer is intentionally unrelated to any memory or identity concept.

## Test evidence

Passed:

- `npx vitest --run test/filesystem-policy.test.ts` — 11 tests.
- Focused related suite (`filesystem-policy`, path utilities, tools, extension loader/runner, executeTool hooks) — all
  tests passed.
- `npm run check` — Biome, pinned dependencies, import validation, generated install locks, TypeScript, browser smoke.
- `npm run build` — all workspace build phases passed.
- Real CLI policy QA — model requested a denied write, the denial reached the second model request, the target remained
  absent, and the final turn completed.
- Senpi QA common harness self-check — 9/9.
- Senpi QA RPC self-test — 4/4.
- Senpi QA mock loop with a real tool turn — 4/4.

QA receipts are under `local-ignore/qa-evidence/20260809-extension-fs-policy/`.

Package-wide test note:

- After building workspace artifacts, the package run completed with 6,991 passing and 35 skipped tests. One unrelated
  app-server Goal test failed only in the package-wide order (`thread/goal/clear` reported the second clear as true).
- The unchanged failing file passes in isolation: 8/8. The same package-wide ordering failure reproduced under `CI=1`.
  No Goal or app-server source was changed in this PR.
