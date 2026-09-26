# Computer use

Senpi can drive the real desktop: take screenshots, click and type into native applications, and read the operating system's accessibility tree. It does this through the `computer` tool, backed by a small native engine (`senpi-desktop-engine`) that senpi starts on first use. By default, input goes to windows in the background, so the app you are using keeps focus, and a global stop chord halts all input at any moment.

The tool's action contract is in [tools/computer.md](tools/computer.md).

## Finding and turning on the tool

The `computer` tool is registered on macOS, Linux, and Windows, but it is not in the model's tool list up front. The model finds it with `tool_search`:

```text
tool_search "computer"
```

Once the model activates it, eval cells get a `computer` global (JavaScript and Python), and the user's stop chord is armed. You control it with the `/computer` command:

| Command | Effect |
|---------|--------|
| `/computer status` | Shows whether it is enabled and active, the engine state, the capabilities, and whether input is suspended |
| `/computer on` / `/computer off` | Turns computer use on or off for this session |
| `/computer stop` | Suspends all input at once |
| `/computer resume` | Lifts a stop. Only you can resume; the model has no action that reaches it |

`/computer` also works over RPC through the ordinary command dispatch. To keep the tool from registering at all, set `computer.enabled` to `false` in `settings.json`.

## Permissions

The permission system checks inspection (screenshots, window lists, the accessibility tree, a `run` with `read_only: true`) as `computer:read`, and anything that sends input or changes state as `computer:exec`.

The active preset decides what happens without explicit rules:

| Preset | `computer` calls |
|--------|------------------|
| `full-access` (default) | Allowed without prompting |
| `workspace`, `read-only`, `ask` | Prompt |

Non-interactive modes (print, RPC without a UI) cannot prompt, so a call that would `ask` is blocked unless a rule allows it first. Rules use the usual syntax:

```bash
senpi --permission computer:read=allow --permission computer:exec=ask
```

## The stop chord

While the tool is active, a global stop chord suspends all desktop input immediately and releases any held keys or buttons:

| Platform | Default chord |
|----------|---------------|
| macOS | `ctrl+alt+cmd+escape` (Control+Option+Command+Escape) |
| Linux, Windows | `ctrl+alt+shift+escape` |

Change it with `computer.stopHotkey`. After a stop, every input call fails with `Suspended` until you run `/computer resume`.

Input is only allowed while a stop path is live. If the global chord cannot be armed (another app holds it, or the platform offers no global listener), input fails with `StopPathUnavailable`. Setting `computer.allowHostRelayOnlyStop` to `true` accepts senpi's own `/computer stop` as the only stop path instead. Leave it off unless you understand that the chord then does nothing.

## Settings

All settings live under `computer` in `settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` on supported hosts | Register the `computer` tool |
| `display` | all displays | `all` composites every display; otherwise a display id |
| `maxWidth` / `maxHeight` | `3840` / `2400` | Screenshot size caps |
| `screenshotMaxBytes` | `5000000` | Inline image budget; larger captures degrade to JPEG, then to a file path only |
| `stopHotkey` | per OS, see above | The stop chord |
| `allowHostRelayOnlyStop` | `false` | Accept `/computer stop` as the only stop path |
| `macosCanary` | `"session"` | macOS background-input check, see below; `"off"` skips it |
| `auditLog.enabled` | `true` | Write the audit log |
| `screenshotGc.enabled` / `staleMs` / `scanIntervalMs` | `true` / 12 h / 30 min | Delete old screenshot files |
| `enginePath` | located automatically | Use a specific engine binary |
| `cuaAdapter` | `false` | Also register `computer_actions`, which takes OpenAI computer-use actions |

When a model clicks in screenshot pixels, captures are clamped to 1280x896. That is senpi's coordinate-safe default, not a provider limit.

## OpenAI computer-use actions

With `computer.cuaAdapter: true`, senpi also registers a second search-exposed tool, `computer_actions`, for models prompted with OpenAI's computer-use action schema: `screenshot`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`, `wait`, or a `batch` of them. It runs on the same desktop session, stop chord, permissions, and audit log as `computer`, with no second input path. Pointer coordinates are checked against the latest screenshot before any input, a screenshot inside a batch becomes the frame for the actions after it, and a batch stops at its first failure. Failures carry `COMPUTER_*` codes with a recovery hint (for example `COMPUTER_SUSPENDED` or `COMPUTER_COORD_INVALID`). Screenshots and waits are `computer:read`; every other action is `computer:exec`.

## Capabilities

`/computer status` and `computer.capabilities()` report what the current host can do:

| Field | Meaning |
|-------|---------|
| `backend` | `quartz` (macOS), `x11`, `wayland`, or `win32` |
| `capture`, `input`, `ax` | Whether screenshots, input, and accessibility work right now |
| `capturePermission`, `inputPermission`, `axPermission` | `granted`, `denied`, `prompt-or-granted` (asked on first use), `unavailable`, or a platform reason such as `bus-unreachable` |
| `backgroundWindowInput`, `deliveryModes` | Whether input can reach a window without bringing it to the front |
| `focusGuard` | Foreground input restores the previous front window and cursor afterwards |
| `stopPath`, `stopReason` | `global` when the chord is armed; `host-relay` or `none` otherwise, with the reason |
| `integrityLevel` | Windows only: the engine's integrity level (see UIPI below) |
| `screenLocked` | Input is refused with `ScreenLocked` while the screen is locked |

## Platforms

### macOS

- Grant **Screen Recording** and **Accessibility** to the app that launches senpi, such as Terminal or iTerm, in System Settings > Privacy & Security. macOS attributes the engine to its launcher: the engine binary is ad-hoc signed and not notarized, so grants attach to the terminal, not to the binary. You must be logged in at the console (the Aqua session); an SSH shell cannot use these grants.
- Background input uses SkyLight so the app you are using keeps focus. Background keyboard input goes only to an app's sole window. A process with several windows gets `BackgroundUnavailable`; use accessibility actions or foreground delivery instead.
- Once per session, before the first background input, senpi shows a small dialog to check that background delivery works on this macOS build (the canary). `computer.macosCanary: "off"` skips it.

### Linux (X11)

- Capture uses RandR and input uses XTEST and XSendEvent. Toolkits that drop synthetic events (for example GTK) refuse background input with `BackgroundUnavailable` naming the toolkit; foreground delivery still works.
- Accessibility uses AT-SPI over D-Bus. If `axPermission` reports `toolkits-silent`, applications are not exporting their trees: enable accessibility with `gsettings set org.gnome.desktop.interface toolkit-accessibility true`, or start GTK apps with `GTK_MODULES=gail:atk-bridge` and Qt apps with `QT_ACCESSIBILITY=1`. `bus-unreachable` means there is no session bus.
- The stop chord uses an XI2 raw-key listener.

### Linux (Wayland)

Wayland support has not yet been tested live on a desktop session.

- Screenshots go through the ScreenCast portal and PipeWire when `libpipewire-0.3.so.0` is installed: every monitor is streamed and the desktop capture is their composite, one display per monitor. The engine loads PipeWire at runtime, so the same binary starts where it is missing and then uses the Screenshot portal instead (one image of the whole desktop). Either portal may show a permission dialog on first use. A compositor whose ScreenCast backend cannot copy the screen (for example wlroots on its pixman software renderer) falls back to the Screenshot portal.
- Input goes through the RemoteDesktop portal and libei. It is background-only, with no per-window targeting and no `raise`. The portal asks for consent on first input, so `inputPermission` reports `prompt-or-granted` until then.
- The stop chord uses the GlobalShortcuts portal (GNOME 45+, KDE Plasma 6). Where it is missing, the global stop path is unavailable and input requires `allowHostRelayOnlyStop`.

### Windows

- Capture is per-monitor DPI aware (PER_MONITOR_AWARE_V2), and accessibility uses UI Automation.
- Windows blocks input from a lower integrity level to a higher one (UIPI). Input to an elevated window is refused with `PermissionDenied` instead of being silently dropped; run senpi elevated, or use accessibility actions.
- Background input posts window messages. WPF and Chromium-based windows ignore posted input and refuse it with `BackgroundUnavailable`; use foreground delivery.
- arm64 is best-effort.

## Audit log and privacy

Every input action is appended to `.computer-audit.jsonl` in the session directory: the action, the target, the delivery mode, and the outcome. Typed text is recorded only as its length and a digest, never the text itself. Turn it off with `computer.auditLog.enabled: false`.

## Error codes

| Code | Meaning |
|------|---------|
| `PermissionDenied` | A missing OS permission, an elevated target window, or a refused resume |
| `CaptureFailed`, `InputFailed` | The platform call failed |
| `BackgroundUnavailable` | This window or toolkit cannot take background input; use AX or `delivery: "foreground"` |
| `WindowNotFound`, `InvalidTarget` | The target window is gone or the target is malformed |
| `InvalidKey` | A key name the platform cannot type |
| `InvalidCoordinateFrame` | The coordinates refer to an older screenshot; take a new one |
| `StaleRef` | An accessibility ref from an older snapshot |
| `AxUnsupported`, `AxFailed` | Accessibility is unavailable, or the action failed |
| `StopPathUnavailable` | No live stop path; see the stop chord section |
| `Suspended` | The stop chord or `/computer stop` suspended input; only `/computer resume` lifts it |
| `ScreenLocked` | The screen is locked |
| `CursorRestoreFailed`, `FocusRestoreFailed`, `TransactionFailed` | Foreground input ran, but restoring the previous state failed |
| `Timeout`, `Cancelled`, `Closed`, `Internal` | The call timed out, was cancelled, hit a closed session, or failed inside the engine |

## Troubleshooting

- `capturePermission: denied` on macOS: grant Screen Recording to the terminal that launched senpi, then restart it.
- `stopPath: none` with `stopReason: no-global-listener`: another app holds the chord, or the platform has no global listener. Pick another `computer.stopHotkey`.
- `BackgroundUnavailable` on every call to one app: that toolkit ignores synthetic input. Use AX actions (`win.ax()`, then `el.press()`) or `delivery: "foreground"`.
- `native-unavailable` in `/computer status`: no engine prebuild exists for this platform and architecture. Build it with `cargo build --release -p senpi-desktop-engine` and set `computer.enginePath`.

## Running the engine standalone / under bunshin

The engine is a separate binary with its own protocol, so it can run without senpi:

- `senpi-desktop-engine --stdio` serves JSON-RPC 2.0 over NDJSON on stdin/stdout. This is how senpi runs it.
- `senpi-desktop-engine --serve <socket>` runs a daemon. It opens its own session from its flags (`--audit-path`, `--artifact-dir`, `--max-width`, `--max-height`, `--max-bytes`, `--display`, `--stop-chord`, `--allow-host-relay-only-stop`) and arms the stop chord at startup. The resume token goes to a file only you can read, and `senpi-desktop-engine --resume` lifts a stop.
- `senpi-desktop-engine --oneshot` forwards one `desktop.<method>` request to the daemon, starting it if needed. Session and stop-path controls never cross this bridge, except `desktop.stop` and `desktop.stopPath.status`.
- `senpi-desktop-engine --mcp` is an MCP stdio server (tools capability) for other agent hosts. It is a persistent `--oneshot`: `tools/list` offers the same methods as tools named `desktop_<method>` (`desktop_capture`, `desktop_click`, `desktop_stop`, ...), and every call goes through the same bridge to the same daemon. `stopPath.resume` is never a tool, a capture comes back as an MCP image block, and an engine error comes back as an `isError` result that carries the engine error unchanged. With `--allow-host-relay-only-stop`, the MCP host must also call `desktop_stopPath_heartbeat` to keep that stop path live.

`packages/desktop-engine/bunshin/desktop.capability.json` is a bunshin sidecar descriptor for the oneshot bridge. `node scripts/install-bunshin-desktop-capability.mjs` installs it into the agent's capability directory with this host's engine path. Inspection ops are `read`, and input ops are `mutate`, so they need a capability token. Stopping is `read`, so it never needs one.

Hosting the engine natively in bunshin (one long-lived session per machine, a fleet-level pause, binary screenshot artifacts, and agents that run inside the graphical session on Linux and Windows) is tracked in [code-yeongyu/bunshin#192](https://github.com/code-yeongyu/bunshin/issues/192).

## omo

omo picks up computer use from the senpi runtime; nothing in omo's prompts has to change. Adopting a senpi release that contains it means checking the following:

- The `computer-use` skill appears in the skill list on supported hosts. The builtin contributes it through `resources_discover` from the model-facing reference and safety rules in `packages/desktop-prelude/docs`, and contributes nothing when the tool is unavailable.
- The `computer.*` settings pass through unchanged, including `computer.enabled` for hosts that should never register the tool.
- `/computer on|off|status|stop|resume` works in omo's TUI and over RPC, including in the desktop app.
- The `computer`, `computer:read`, and `computer:exec` permission rules behave as described above. Non-interactive runs block `ask` unless a rule allows the call.
- The per-OS prerequisites (the macOS grants to the launching terminal, the Linux accessibility bus, the Windows integrity level) are in omo's setup docs.
- The `senpi-desktop-engine` binary ships next to the omo binary as a sidecar, like the other native prebuilds. Without it, `/computer status` reports `native-unavailable`.

Release-note paragraph:

> **Computer use.** omo can now drive your real desktop on macOS, Linux, and Windows: screenshots, clicks and typing into native apps, and the OS accessibility tree. Input goes to background windows by default, so the app you are using keeps focus. A global stop chord (Control+Option+Command+Escape on macOS, Ctrl+Alt+Shift+Escape elsewhere) halts everything instantly, and only you can resume. The model finds the tool with `tool_search "computer"`, the `computer:read` and `computer:exec` permission tiers control it, and `/computer status` shows what your machine supports.

## Not yet

- Video, and capture of a single window on Wayland.
- A provider-hosted `computer_use_preview` tool; senpi drives the desktop through its own `computer` tool.
