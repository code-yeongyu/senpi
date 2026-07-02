# App Server Daemon

App Server daemon commands start, attach to, inspect, and stop a background app-server listener for Codex-compatible app and editor integrations.

## Starting The Daemon

```bash
senpi app-server daemon start
```

The daemon default listener is `ws://127.0.0.1:18800`. It uses the same bearer-token websocket authentication as app-server mode; the token file is `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token`.

Use `--listen` to choose another supported app-server transport:

```bash
senpi app-server daemon start --listen ws://127.0.0.1:18800
senpi app-server daemon start --listen unix://
senpi app-server daemon start --listen unix:///tmp/senpi-app-server.sock
```

## Subcommands

Every daemon command prints exactly one JSON object to stdout.

### start

`start` first probes the requested listener. If a compatible app-server already answers `initialize`, the command attaches to it instead of spawning another process.

Started a managed daemon:

```json
{"status":"started","pid":12345,"listen":"ws://127.0.0.1:18800"}
```

Attached to a managed daemon that is already running:

```json
{"status":"already-running","pid":12345,"listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

Attached to a compatible listener without a matching managed pidfile:

```json
{"status":"already-running","listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

### status

Managed daemon is running:

```json
{"status":"running","pid":12345,"listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

Compatible listener exists, but it is not tracked by the daemon pidfile:

```json
{"status":"running-unmanaged","listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

No compatible listener is running:

```json
{"status":"not-running"}
```

### stop

Stopped a managed daemon:

```json
{"status":"stopped"}
```

Nothing was running:

```json
{"status":"not-running"}
```

### restart

`restart` stops the managed daemon, then starts it again. It preserves the previous daemon flags from `settings.json` when available, so a daemon started with `--listen unix:///tmp/senpi-app-server.sock` restarts with the same listener even if the restart command omits `--listen`.

```bash
senpi app-server daemon restart
```

The final stdout object is the `start` result, usually `{"status":"started",...}`.

## State Directory

Daemon state lives under `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}`:

```text
app-server-daemon/
  app-server.pid
  daemon.lock
  settings.json
app-server/
  ws-token
  app-server.sock
```

`app-server.pid` stores the daemon pid and process start time to avoid PID reuse. `daemon.lock` serializes daemon commands. `settings.json` stores the launch intent used by `restart`. `app-server.sock` is the default websocket-over-UDS socket path for `unix://`; an explicit `unix:///absolute/path` uses that absolute socket path instead.

## Spawn Or Attach

`start` is idempotent:

1. Probe the requested listener with a real `initialize` request.
2. If the listener answers, print `already-running`.
3. If a matching pidfile exists, wait briefly for that process to answer.
4. Otherwise spawn a detached `senpi app-server --listen <url>` process, write the pidfile and settings, then probe until ready.

For websocket listeners, the daemon probe reads the bearer token file and sends `Authorization: Bearer <token>`.

## launchd

For macOS login-session startup, create `~/Library/LaunchAgents/com.senpi.app-server.plist`. Replace `/absolute/path/to/senpi` and `/absolute/path/to/ws-token` with local absolute paths.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.senpi.app-server</string>

  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/senpi</string>
    <string>app-server</string>
    <string>--listen</string>
    <string>ws://127.0.0.1:18800</string>
    <string>--ws-auth</string>
    <string>/absolute/path/to/ws-token</string>
  </array>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardErrorPath</key>
  <string>/tmp/senpi-app-server.err.log</string>

  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
```

Load and unload it with:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.senpi.app-server.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.senpi.app-server.plist
```

Check readiness for the websocket form with:

```bash
curl -fsS http://127.0.0.1:18800/readyz
```

## Security

Keep `ws://` listeners on loopback unless the listener is protected by a bearer token and exposed only over a trusted tailnet or equivalent private network. Do not use `--ws-auth off` outside loopback development.

`unix://` uses websocket framing over a Unix-domain socket. The default socket path is same-user local state and should not be shared across accounts. Use the remote-connection pattern from [App Server Mode](app-server.md#starting-app-server-mode): prefer authenticated loopback websocket for app/editor clients, and use UDS only for same-user local control planes.
