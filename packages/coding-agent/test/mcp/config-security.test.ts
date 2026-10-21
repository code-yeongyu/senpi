import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	interpolateValue,
	loadMcpConfig,
	McpConfigValidationError,
	visitSpawnableMcpServers,
} from "../../src/core/extensions/builtin/mcp/config.ts";
import { makeRoot, writeJson, writeRaw, writeSecretFile } from "./config-test-helpers.ts";

const PROJECT_COMMAND_EXPR = "$" + "{PROJECT_COMMAND}";
const MISSING_COMMAND_EXPR = "$" + "{MISSING_COMMAND}";
const EMPTY_COMMAND_DEFAULT_EXPR = "$" + "{EMPTY_COMMAND:-}";
const MISSING_URL_EXPR = "$" + "{MISSING_URL}";
const EMPTY_URL_DEFAULT_EXPR = "$" + "{EMPTY_URL:-}";

describe("mcp config security boundaries", () => {
	it("rejects command substitution syntax without executing config", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				shellBang: { command: "!curl https://example.invalid/install.sh" },
			},
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true })).toThrow(
			/MCP config interpolation rejected command substitution at mcpServers\.shellBang\.command.*security/i,
		);

		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				subshell: { command: "node", args: ["$(touch should-not-exist)"] },
			},
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true })).toThrow(
			/MCP config interpolation rejected command substitution at mcpServers\.subshell\.args\.0.*security/i,
		);
	});

	it("rejects enabled servers without a matching command or url", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { missingCommand: {} },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true })).toThrow(
			new McpConfigValidationError(
				"Invalid MCP config at mcpServers.missingCommand.command: Required for enabled stdio server",
			),
		);

		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { missingUrl: { type: "http" } },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true })).toThrow(
			new McpConfigValidationError(
				"Invalid MCP config at mcpServers.missingUrl.url: Required for enabled http server",
			),
		);
	});

	it("rejects enabled stdio servers when interpolation produces an empty command", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { emptyAfterEnv: { command: MISSING_COMMAND_EXPR } },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, env: {}, projectTrusted: true })).toThrow(
			new McpConfigValidationError(
				"Invalid MCP config at mcpServers.emptyAfterEnv.command: Required for enabled stdio server",
			),
		);

		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { emptyDefault: { command: EMPTY_COMMAND_DEFAULT_EXPR } },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, env: {}, projectTrusted: true })).toThrow(
			new McpConfigValidationError(
				"Invalid MCP config at mcpServers.emptyDefault.command: Required for enabled stdio server",
			),
		);
	});

	it("rejects enabled http servers when interpolation produces an empty url", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { emptyAfterEnv: { type: "http", url: MISSING_URL_EXPR } },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, env: {}, projectTrusted: true })).toThrow(
			new McpConfigValidationError(
				"Invalid MCP config at mcpServers.emptyAfterEnv.url: Required for enabled http server",
			),
		);

		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { emptyDefault: { type: "http", url: EMPTY_URL_DEFAULT_EXPR } },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, env: {}, projectTrusted: true })).toThrow(
			new McpConfigValidationError(
				"Invalid MCP config at mcpServers.emptyDefault.url: Required for enabled http server",
			),
		);
	});

	it("allows disabled placeholder servers without command or url", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { disabled: { enabled: false } },
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.servers.disabled).toMatchObject({ source: "global", state: "disabled" });
	});

	it("blocks untrusted project servers before interpolation and spawn", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { globalOnly: { command: "global" } },
		});
		writeJson(join(root.cwd, ".senpi", "mcp.json"), {
			mcpServers: { projectOnly: { command: PROJECT_COMMAND_EXPR } },
		});
		const spawn = vi.fn();

		const result = loadMcpConfig({
			agentDir: root.agentDir,
			cwd: root.cwd,
			env: { PROJECT_COMMAND: "must-not-interpolate" },
			projectTrusted: false,
		});
		visitSpawnableMcpServers(result, spawn);

		expect(result.servers.globalOnly).toMatchObject({ source: "global", state: "enabled" });
		expect(result.servers.projectOnly).toMatchObject({ source: "project", state: "untrusted" });
		expect(result.servers.projectOnly.config).toBeUndefined();
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith("globalOnly", result.servers.globalOnly);
	});

	it("does not let untrusted project or imported configs shadow trusted global servers", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			settings: { importConfigs: ["claude"] },
			mcpServers: { x: { command: "global-x" } },
		});
		writeJson(join(root.cwd, ".mcp.json"), {
			mcpServers: { x: { command: "claude-x" }, claudeOnly: { command: "claude-only" } },
		});
		writeJson(join(root.cwd, ".senpi", "mcp.json"), {
			mcpServers: { x: { command: "project-x" }, projectOnly: { command: "project-only" } },
		});
		const spawn = vi.fn();

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: false });
		visitSpawnableMcpServers(result, spawn);

		expect(result.servers.x).toMatchObject({
			source: "global",
			state: "enabled",
			config: { command: "global-x" },
		});
		expect(result.servers.claudeOnly).toMatchObject({ source: "claude", state: "untrusted" });
		expect(result.servers.projectOnly).toMatchObject({ source: "project", state: "untrusted" });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith("x", result.servers.x);
	});

	it("reports malformed untrusted project config without aborting trusted global config", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { globalOnly: { command: "global" } },
		});
		writeRaw(join(root.cwd, ".senpi", "mcp.json"), "{");
		const spawn = vi.fn();

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: false });
		visitSpawnableMcpServers(result, spawn);

		expect(result.servers.globalOnly).toMatchObject({ source: "global", state: "enabled" });
		expect(result.diagnostics).toEqual([
			expect.stringMatching(/Blocked untrusted MCP config at .*\.senpi\/mcp\.json: invalid JSON/i),
		]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith("globalOnly", result.servers.globalOnly);
	});

	it("loads project servers when project trust is active", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { globalOnly: { command: "global" } },
		});
		writeJson(join(root.cwd, ".senpi", "mcp.json"), {
			mcpServers: { projectOnly: { command: PROJECT_COMMAND_EXPR } },
		});

		const result = loadMcpConfig({
			agentDir: root.agentDir,
			cwd: root.cwd,
			env: { PROJECT_COMMAND: "trusted-command" },
			projectTrusted: true,
		});

		expect(result.servers.projectOnly).toMatchObject({
			source: "project",
			state: "enabled",
			config: { command: "trusted-command" },
		});
	});
});

/**
 * `{file:<path>}` keeps a bearer token in the file the user already curates
 * instead of copying its bytes into `mcp.json`. Like `${VAR}` it expands only
 * for trusted sources, and every refusal names the file and the reason so the
 * user can fix the reference without guessing.
 */
describe("mcp config {file:...} boundaries", () => {
	// One temp dir per test: credential files live under it, and it is removed with
	// the mode bits the tests set on them.
	let secretDir: string;

	beforeEach(() => {
		secretDir = makeRoot().cwd;
	});

	afterEach(() => {
		if (existsSync(secretDir)) rmSync(secretDir, { recursive: true, force: true });
	});

	it("expands a trusted file reference in an http header and strips its trailing newline", () => {
		const token = writeSecretFile(secretDir, "mcp-bearer-token\n");
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				docs: {
					type: "http",
					url: "https://docs.example/mcp",
					headers: { Authorization: `Bearer {file:${token}}` },
				},
			},
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, env: {}, projectTrusted: true });

		expect(result.servers.docs.config?.headers).toEqual({ Authorization: "Bearer mcp-bearer-token" });
	});

	it(`expands a file reference and a $${"{VAR}"} fallback in the same value`, () => {
		const token = writeSecretFile(secretDir, "from-file");
		expect(interpolateValue({ headers: { Authorization: `Bearer {file:${token}}` } }, "mcp", {})).toEqual({
			headers: { Authorization: "Bearer from-file" },
		});
		expect(interpolateValue({ args: [`{file:${token}}`, "$" + "{UNSET_VAR:-default}"] }, "mcp", {})).toEqual({
			args: ["from-file", "default"],
		});
	});

	it("names the config path, the file and the reason when the reference is unusable", () => {
		const missing = join(secretDir, "absent-token");
		const config = { mcpServers: { docs: { headers: { Authorization: `{file:${missing}}` } } } };
		expect(() => interpolateValue(config, "mcp", {})).toThrow(
			new McpConfigValidationError(
				`MCP config interpolation could not resolve {file:${missing}} at mcpServers.docs.headers.Authorization: file does not exist: ${missing}`,
			),
		);
	});

	it("reports a relative reference as an absolute-path error, not a missing file", () => {
		// The shape error is the whole message, so it cannot also be a missing-file report.
		expect(() => interpolateValue({ headers: { Authorization: "{file:./token}" } }, "mcp", {})).toThrow(
			"MCP config interpolation could not resolve {file:./token} at headers.Authorization: absolute path required, got ./token",
		);
	});

	it("reports an empty credential file instead of sending an empty header", () => {
		const empty = writeSecretFile(secretDir, "");
		expect(() => interpolateValue({ headers: { Authorization: `{file:${empty}}` } }, "mcp", {})).toThrow(
			new RegExp(`file is empty: ${empty}`),
		);
	});

	it.skipIf(process.getuid?.() === 0)(
		"reports an unreadable credential file instead of falling back to a literal",
		() => {
			const locked = writeSecretFile(secretDir, "locked-secret");
			chmodSync(locked, 0o000);
			try {
				expect(() => interpolateValue({ headers: { Authorization: `{file:${locked}}` } }, "mcp", {})).toThrow(
					new RegExp(`permission denied: ${locked}`),
				);
			} finally {
				chmodSync(locked, 0o600);
			}
		},
	);

	it("never expands a file reference for an untrusted project config", () => {
		const token = writeSecretFile(secretDir, "should-not-be-read");
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), { mcpServers: { globalOnly: { command: "global" } } });
		writeJson(join(root.cwd, ".senpi", "mcp.json"), {
			mcpServers: {
				projectOnly: { type: "http", url: "https://p.example/mcp", headers: { Authorization: `{file:${token}}` } },
			},
		});

		// A repository must not be able to name a file on the machine and have the
		// engine read it into a header the project chose.
		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: false });

		expect(result.servers.projectOnly).toMatchObject({ source: "project", state: "untrusted" });
		expect(result.servers.projectOnly.config).toBeUndefined();
	});

	it("inserts a resolved body as data and never re-inspects it as a command", () => {
		// Given a credential file whose bytes look like command substitution
		const body = "$(touch should-not-exist) !curl https://example.invalid/install.sh";
		const token = writeSecretFile(secretDir, `${body}\n`);
		// Then the body is one argv element, verbatim; stdio servers never see a shell
		expect(interpolateValue({ mcpServers: { x: { args: [`{file:${token}}`] } } }, "mcp", {})).toEqual({
			mcpServers: { x: { args: [body] } },
		});
		expect(existsSync(join(secretDir, "should-not-exist"))).toBe(false);
	});
});
