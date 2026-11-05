# Agent directory selection

Run `senpi config agent-dir --json` to ask the same `getAgentDir()` used by sessions which agent directory it would use for the current working directory, home, environment, and brand. Rebranded launchers use their own command name.

The command reads directory layout and selector inputs. It does not open credentials or settings, migrate files, create engine state or marker files, prepare a runtime snapshot, register providers, or start a host. The source launcher, direct CLI entry, and compiled Bun entry all handle it before normal startup.

Every outcome is a single JSON record on standard output. Consumers must check `version`, `ok`, and the process exit code.

```json
{"version":1,"ok":true,"dir":"/example/agent","source":"SENPI_CODING_AGENT_DIR","rule":"environment","brandedPrefix":"SENPI"}
```

For version 1, `source` is the name of the selected environment variable, `project-local`, or `default`. `rule` is `environment`, `project-local`, or `home-default`. An explicitly empty first-defined selector follows the same fallback as a session; it does not allow a lower-priority variable to take over.

Exit codes:

- `0`: `ok: true`, with `dir`, `source`, `rule`, and `brandedPrefix`.
- `2`: `ok: false`, `code: "invalid_arguments"`, and a usage `message`. This includes an omitted `--json`, unsupported flags, and extra arguments.
- `1`: `ok: false`, `code: "selection_failed"`, and an error `message`. No stack trace is written to standard error.

```json
{"version":1,"ok":false,"code":"invalid_arguments","message":"Usage: senpi config agent-dir --json"}
```

A desktop integration must keep its current directory and show an actionable notice when the command fails, times out, or returns a contract it cannot validate. It must query the same runtime and effective environment that will run its sessions, not substitute another installed engine.
