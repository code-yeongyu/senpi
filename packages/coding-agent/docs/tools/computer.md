# computer tool

> The contract of the `computer` tool and the `computer` eval global it adds: what each action takes, what it returns, and how calls are classified. User setup, permissions, the stop chord, and platform limits are in [Computer use](../computer-use.md).

## Source

- Tool definition, parameters, and permission tiers: `packages/desktop-tool/src/tool.ts`, `packages/desktop-tool/src/params.ts`, `packages/desktop-tool/src/permission.ts`
- `/computer` command and settings: `packages/desktop-tool/src/command.ts`, `packages/desktop-tool/src/settings.ts`
- Builtin registration and `tool_search` exposure: `packages/coding-agent/src/core/extensions/builtin/computer-use/index.ts`
- Eval facades and model-facing docs: `packages/desktop-prelude/src/prelude.js`, `packages/desktop-prelude/src/prelude.py`, `packages/desktop-prelude/docs/computer.md`, `packages/desktop-prelude/docs/computer-safety.md`
- Engine client and the `computer.run` runtime: `packages/desktop-service/src/service`, `packages/desktop-service/src/run`
- Engine protocol and schema: `packages/desktop-protocol/src`, `crates/senpi-desktop-core/schema/engine.schema.json`
- Engine and platform backends: `crates/senpi-desktop-engine`, `crates/senpi-desktop-session`, `crates/senpi-desktop-backend-macos`, `crates/senpi-desktop-backend-x11`, `crates/senpi-desktop-backend-wayland`, `crates/senpi-desktop-backend-win32`, `crates/senpi-desktop-backend-atspi`

## Exposure

The tool is registered on macOS, Linux, and Windows unless `computer.enabled` is `false`. It is exposed through `tool_search` only and is not in the model's initial tool list. When it becomes active, eval kernels receive the `computer` global in the next cell, and the user's stop chord is armed. The engine child starts lazily on the first call.

## Actions

The tool takes one of four actions:

| `action` | Parameters | Result |
|----------|------------|--------|
| `call` | `chain`: one desktop helper `{ method, args? }`, optionally followed by one call on the window or element it returns | The helper's value (a screenshot also returns an image) |
| `run` | `code` (async function body with `desktop`, `wait`, `assert`, `tool` in scope), `read_only?`, `timeout?` in seconds (default 60, max 600) | The value the code returns |
| `capabilities` | none | The engine's capabilities |
| `close` | none | Ends the desktop session |

There is deliberately no `resume` action: only the user lifts a stop, with `/computer resume`.

The eval global wraps these actions: every helper is one `call`, and `computer.run(...)` is `run`. The full helper list with signatures is the model-facing reference in `packages/desktop-prelude/docs/computer.md`.

## Permission classification

Each call is classified before it runs:

| Call | Tier |
|------|------|
| `capabilities` | `computer:read` |
| `call` whose chain only inspects (screenshots, windows, displays, AX reads, clipboard read) | `computer:read` |
| `run` with `read_only: true` | `computer:read`; the runtime blocks any input or mutation |
| `close`, any other `call` or `run`, and any malformed input | `computer:exec` |

The permission system evaluates the tier against the active preset and rules; see [Computer use](../computer-use.md#permissions).

## Coordinates and frames

- Pointer coordinates are pixels in the most recent screenshot of the same target. The engine checks the frame, and a stale frame fails with `InvalidCoordinateFrame`.
- Accessibility coordinates (`elementAt`, element bounds) are global desktop coordinates; never mix the two.
- Each accessibility snapshot starts a new ref generation. Refs from the current and previous generations stay valid; older ones fail with `StaleRef`.

## Delivery

Input defaults to `delivery: "background"`, which never takes the user's focus. `delivery: "foreground"` activates the target briefly. The focus guard then restores the previous front window and cursor, and reports `FocusRestoreFailed` or `CursorRestoreFailed` if it cannot. Whether background delivery is possible depends on the platform and toolkit; see the Platforms section of [Computer use](../computer-use.md#platforms).

## Safety contract

- Every input action passes one gate before it reaches the backend: stop-path liveness, suspension, the OS input permission, the screen lock, and the coordinate frame. A refused action touches nothing.
- The stop chord or `/computer stop` suspends input and releases every held key and button. Suspension holds until the user's `/computer resume`.
- Screen content is untrusted input. The safety prompt the model receives is `packages/desktop-prelude/docs/computer-safety.md`.
- Every input action is audited to `.computer-audit.jsonl` in the session directory; typed text is recorded as a length and digest only.
