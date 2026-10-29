#!/usr/bin/env node
// A stand-in for the bundled Claude Code CLI (2.1.306) `auth` commands: it replays the stdout lines,
// exit codes and `$BROWSER` call that `claude auth login|status|logout` make, and records what it was
// given (argv, the names of its environment, the configured dir, stdin) to FAKE_CLAUDE_RECORD.
// FAKE_CLAUDE_MODE picks the scenario. No network, no credential store.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CLAUDE_MODE ?? "login-paste";
const record = (entry) => {
	if (process.env.FAKE_CLAUDE_RECORD) appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify(entry)}\n`);
};
record({
	pid: process.pid,
	argv: process.argv.slice(2),
	envNames: Object.keys(process.env).sort(),
	configDir: process.env.CLAUDE_CONFIG_DIR,
	noColor: process.env.NO_COLOR,
	cwd: process.cwd(),
});

const [group, command] = process.argv.slice(2);
const MANUAL_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=fixture&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fixture-state";
const AUTOMATIC_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=fixture&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fixture-state";

if (group === "auth" && command === "status") {
	const statuses = {
		"status-claudeai": {
			loggedIn: true,
			authMethod: "claude.ai",
			apiProvider: "firstParty",
			email: "user@example.com",
			orgId: "org-fixture",
			orgName: "Fixture Org",
			subscriptionType: "max",
			configDirectory: process.env.CLAUDE_CONFIG_DIR,
		},
		"status-apikey": { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" },
		"status-bedrock": { loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" },
		"status-loggedout": { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
	};
	if (mode === "status-garbage") {
		process.stdout.write("not json\n");
		process.exit(0);
	}
	const status = statuses[mode] ?? statuses["status-loggedout"];
	process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
	process.exit(status.loggedIn ? 0 : 1);
}

if (group === "auth" && command === "logout") {
	process.stdout.write("Successfully logged out from your Anthropic account.\n");
	process.exit(mode === "logout-fail" ? 1 : 0);
}

if (group !== "auth" || command !== "login") process.exit(2);

if (mode === "login-hang") process.on("SIGTERM", () => record({ sigterm: true }));
process.stdout.write("Opening browser to sign in…\n");
process.stdout.write(`If the browser didn't open, visit: ${MANUAL_URL}\n`);
if (process.env.BROWSER) spawnSync(process.env.BROWSER, [AUTOMATIC_URL], { stdio: "ignore" });
process.stdout.write("Paste code here if prompted > ");

if (mode === "login-hang") {
	setInterval(() => {}, 1 << 30);
} else if (mode === "login-auto") {
	process.stdout.write("\nLogin successful.\n");
	process.exit(0);
} else if (mode === "login-org-denied") {
	process.stderr.write("OAuth login failed: cli_auth_login_org_not_allowed\n");
	process.exit(1);
} else {
	const lines = createInterface({ input: process.stdin });
	lines.once("line", (line) => {
		record({ stdin: line });
		if (mode === "login-exit0-silent") process.exit(0);
		process.stdout.write("\nLogin successful.\n");
		process.exit(0);
	});
}
