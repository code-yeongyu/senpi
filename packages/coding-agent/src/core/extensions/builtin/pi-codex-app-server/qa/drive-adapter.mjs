#!/usr/bin/env node

const HELP_TEXT = `pi-codex-app-server adapter harness

Usage:
  node packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/qa/drive-adapter.mjs --help

Options:
  --help                         Show this help text.
  --external-stdio               Reserved for PR-004 stdio adapter driving.
  --external-websocket <host>    Reserved for PR-004 websocket adapter driving.
  --external-unix <path>         Reserved for PR-004 unix-socket adapter driving.
  --app-server-command <path>    Reserved for the Codex app-server binary path.
  --app-server-args <args>       Reserved for Codex app-server command arguments.
  --app-server-url <url>         Reserved for a shared Codex app-server websocket URL.

Status:
  PR-002 skeleton only. Runtime transport, protocol routing, streaming,
  callbacks, reconnect, and redaction are intentionally deferred.
`;

function main(argv) {
	if (argv.length === 0 || argv.includes("--help")) {
		process.stdout.write(HELP_TEXT);
		return 0;
	}

	process.stderr.write("drive-adapter.mjs is a PR-002 harness shell; runtime driving is deferred.\n");
	return 2;
}

process.exitCode = main(process.argv.slice(2));
