import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	loadMcpConfig,
	McpConfigValidationError,
	visitSpawnableMcpServers,
} from "../../src/core/extensions/builtin/mcp/config.ts";
import { makeRoot, writeJson, writeRaw } from "./config-test-helpers.ts";

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
