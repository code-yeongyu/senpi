import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	logoutClaudeCli,
	parseClaudeCliAuthStatus,
	readClaudeCliAuthStatus,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import { buildClaudeCliEnvironment } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-environment.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "claude-cli-auth", "fake-claude.mjs");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(mode: string, extraEnv: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(join(tmpdir(), "senpi-claude-cli-status-"));
	roots.push(root);
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	const recordPath = join(root, "record.jsonl");
	const configDir = join(root, "account");
	mkdirSync(configDir);
	const parentEnv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: root,
		FAKE_CLAUDE_MODE: mode,
		FAKE_CLAUDE_RECORD: recordPath,
		...extraEnv,
	};
	const firstRecord = () =>
		JSON.parse(readFileSync(recordPath, "utf8").split("\n")[0] ?? "{}") as {
			envNames: string[];
			argv: string[];
			configDir: string;
		};
	return { run: { executable, configDir, parentEnv }, firstRecord };
}

const LEAKY_HOST = {
	ANTHROPIC_API_KEY: "dummy-key",
	CLAUDE_CODE_OAUTH_TOKEN: "dummy-token",
	CLAUDE_CODE_OAUTH_TOKEN_2: "dummy-token-2",
	CLAUDE_SECURESTORAGE_CONFIG_DIR: "/elsewhere/secure",
	CLAUDE_CONFIG_DIR: "/elsewhere/config",
	BROWSER: "/usr/bin/host-browser",
	SENPI_CLAUDE_SDK_OAUTH_RESUME: "off",
};

describe("Claude CLI environment", () => {
	it("strips host credentials and config redirects, then pins the account dir", () => {
		const env = buildClaudeCliEnvironment(
			{ PATH: "/bin", ...LEAKY_HOST },
			{ configDir: "/acct", browser: "/helper" },
		);

		for (const name of [
			"ANTHROPIC_API_KEY",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN_2",
			"CLAUDE_SECURESTORAGE_CONFIG_DIR",
			"SENPI_CLAUDE_SDK_OAUTH_RESUME",
		]) {
			expect(env).not.toHaveProperty(name);
		}
		expect(env).toMatchObject({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/acct", BROWSER: "/helper", NO_COLOR: "1" });
	});

	it("drops an inherited BROWSER when no helper is given", () => {
		expect(
			buildClaudeCliEnvironment({ BROWSER: "/usr/bin/host-browser" }, { configDir: "/acct" }),
		).not.toHaveProperty("BROWSER");
	});

	it("the spawned CLI never sees the stripped names", async () => {
		const { run, firstRecord } = setup("status-claudeai", LEAKY_HOST);

		await readClaudeCliAuthStatus(run);

		const { envNames, argv, configDir } = firstRecord();
		expect(argv).toEqual(["auth", "status", "--json"]);
		expect(configDir).toBe(run.configDir);
		for (const name of [
			"ANTHROPIC_API_KEY",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN_2",
			"CLAUDE_SECURESTORAGE_CONFIG_DIR",
			"BROWSER",
		]) {
			expect(envNames).not.toContain(name);
		}
	});
});

describe("claude auth status --json", () => {
	it("accepts a first-party claude.ai login and keeps only the profile fields", async () => {
		expect(await readClaudeCliAuthStatus(setup("status-claudeai").run)).toEqual({
			state: "signed_in",
			profile: { email: "user@example.com", orgName: "Fixture Org", subscriptionType: "max" },
		});
	});

	it("rejects an API-key login", async () => {
		expect(await readClaudeCliAuthStatus(setup("status-apikey").run)).toEqual({
			state: "rejected",
			reason: "auth_method",
		});
	});

	it("rejects a non-first-party provider", async () => {
		expect(await readClaudeCliAuthStatus(setup("status-bedrock").run)).toEqual({
			state: "rejected",
			reason: "api_provider",
		});
	});

	it("reads a logged-out exit 1 as signed out", async () => {
		expect(await readClaudeCliAuthStatus(setup("status-loggedout").run)).toEqual({ state: "signed_out" });
	});

	it("reads non-JSON output as unreadable", async () => {
		expect(await readClaudeCliAuthStatus(setup("status-garbage").run)).toEqual({ state: "unreadable" });
	});

	it("never trusts loggedIn without exit 0", () => {
		expect(
			parseClaudeCliAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', 1),
		).toEqual({
			state: "unreadable",
		});
	});
});

describe("claude auth logout", () => {
	it("reports the CLI's exit status", async () => {
		const ok = setup("logout-ok");
		expect(await logoutClaudeCli(ok.run)).toBe(true);
		expect(ok.firstRecord().argv).toEqual(["auth", "logout"]);
		expect(await logoutClaudeCli(setup("logout-fail").run)).toBe(false);
	});
});
