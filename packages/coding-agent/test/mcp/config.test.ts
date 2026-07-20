import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadMcpConfig,
	McpConfigValidationError,
	mergeExtensionMcpServers,
} from "../../src/core/extensions/builtin/mcp/config.ts";
import { makeRoot, writeJson } from "./config-test-helpers.ts";

const TOKEN_EXPR = "$" + "{TOKEN}";
const TOKEN_DEFAULT_EXPR = "$" + "{TOKEN:-global}";
const CLAUDE_ARG_DEFAULT_EXPR = "$" + "{CLAUDE_ARG:-from-default}";

describe("mcp config", () => {
	it("discovers, merges, imports, interpolates, and normalizes trusted config", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			settings: { importConfigs: ["claude"], nativeToolSearch: "auto", toolPrefix: "global" },
			mcpServers: {
				shared: { command: "global-shared", args: [TOKEN_DEFAULT_EXPR] },
				globalOnly: { url: "https://global.example/mcp", headers: { Authorization: `Bearer ${TOKEN_EXPR}` } },
			},
		});
		writeJson(join(root.cwd, ".mcp.json"), {
			mcpServers: {
				claudeOnly: { command: "claude", args: [CLAUDE_ARG_DEFAULT_EXPR] },
			},
		});
		writeJson(join(root.cwd, ".senpi", "mcp.json"), {
			settings: {
				oauthCallbackUrl: "https://callback.example/finish",
				stubSwap: true,
				toolPrefix: "project",
			},
			mcpServers: {
				shared: {
					command: "project-shared",
					args: [TOKEN_EXPR],
					bearerTokenEnv: "PROJECT_TOKEN",
					oauth: { flow: "client_credentials", scopes: ["tools"] },
					logLevel: "warning",
				},
			},
		});

		const result = loadMcpConfig({
			agentDir: root.agentDir,
			cwd: root.cwd,
			env: { TOKEN: "from-env" },
			projectTrusted: true,
		});

		expect(result.settings).toMatchObject({
			importConfigs: ["claude"],
			nativeToolSearch: "auto",
			oauthCallbackUrl: "https://callback.example/finish",
			stubSwap: true,
			toolPrefix: "project",
		});
		expect(result.servers.shared).toMatchObject({
			source: "project",
			state: "enabled",
			transport: "stdio",
			config: {
				args: ["from-env"],
				bearerTokenEnv: "PROJECT_TOKEN",
				command: "project-shared",
				logLevel: "warning",
				oauth: { flow: "client_credentials", scopes: ["tools"] },
			},
		});
		expect(result.servers.globalOnly).toMatchObject({
			source: "global",
			transport: "http",
			config: { headers: { Authorization: "Bearer from-env" } },
		});
		expect(result.servers.claudeOnly).toMatchObject({
			source: "claude",
			state: "enabled",
			config: { args: ["from-default"] },
		});
		expect(result.diagnostics).toEqual([]);
	});

	it("does not import .mcp.json unless claude import is enabled", () => {
		const root = makeRoot();
		writeJson(join(root.cwd, ".mcp.json"), {
			mcpServers: { claudeOnly: { command: "claude" } },
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.servers.claudeOnly).toBeUndefined();
	});

	it("reports validation failures with exact JSON paths", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: { x: { command: "npx", args: "not-an-array" } },
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true })).toThrow(
			new McpConfigValidationError("Invalid MCP config at mcpServers.x.args: Expected array"),
		);
	});

	it("keeps configHash stable under object key reordering", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				stable: { env: { B: "2", A: "1" }, args: ["a"], command: "node" },
			},
		});
		const first = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				stable: { command: "node", args: ["a"], env: { A: "1", B: "2" } },
			},
		});
		const second = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(second.servers.stable.configHash).toBe(first.servers.stable.configHash);
	});

	it("validates and round-trips reserved inert future fields", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			settings: {
				oauthCallbackUrl: "https://callback.example/mcp",
				stubSwap: false,
				nativeToolSearch: true,
			},
			mcpServers: {
				future: {
					command: "node",
					auth: "oauth",
					bearerTokenEnv: "TOKEN_ENV",
					logLevel: "debug",
					oauth: {
						clientId: "client-id",
						clientMetadataUrl: "https://client.example/metadata.json",
						flow: "code",
						scopes: ["read", "write"],
					},
				},
			},
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.settings).toMatchObject({
			nativeToolSearch: true,
			oauthCallbackUrl: "https://callback.example/mcp",
			stubSwap: false,
		});
		expect(result.servers.future.config).toMatchObject({
			auth: "oauth",
			bearerTokenEnv: "TOKEN_ENV",
			logLevel: "debug",
			oauth: {
				clientId: "client-id",
				clientMetadataUrl: "https://client.example/metadata.json",
				flow: "code",
				scopes: ["read", "write"],
			},
		});
	});

	it("rejects OAuth callbackPort values outside integer TCP port range", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				badPort: {
					type: "http",
					url: "https://auth.example/mcp",
					auth: "oauth",
					oauth: { clientId: "client-id", callbackPort: 65_536 },
				},
			},
		});

		expect(() => loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true })).toThrow(
			/callbackPort/,
		);
	});

	it("validates and round-trips keep-alive server lifecycle", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				keepAlive: {
					command: "node",
					lifecycle: "keep-alive",
				},
			},
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.servers.keepAlive.config).toMatchObject({
			command: "node",
			lifecycle: "keep-alive",
		});
	});

	describe("mergeExtensionMcpServers", () => {
		const extDecl = (
			name: string,
			config: { type: "stdio"; command: string; exposure?: "direct" | "search" | "auto" | "proxy" },
		) => ({
			name,
			config,
			extensionPath: "<ext>",
			registrationCwd: "/tmp/ext",
		});

		it("lets trusted global entries win over extension declarations", () => {
			const root = makeRoot();
			writeJson(join(root.agentDir, "mcp.json"), { mcpServers: { dup: { command: "global" } } });
			const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
			mergeExtensionMcpServers(config, [extDecl("dup", { type: "stdio", command: "ext" })]);
			expect(config.servers.dup).toMatchObject({ source: "global", state: "enabled" });
			expect(config.diagnostics.some((d) => d.includes("dup") && d.includes("global"))).toBe(true);
		});

		it("lets trusted disabled entries win and keeps the server disabled", () => {
			const root = makeRoot();
			writeJson(join(root.agentDir, "mcp.json"), { mcpServers: { dup: { command: "global", enabled: false } } });
			const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
			mergeExtensionMcpServers(config, [extDecl("dup", { type: "stdio", command: "ext" })]);
			expect(config.servers.dup).toMatchObject({ source: "global", state: "disabled" });
		});

		it("replaces untrusted placeholders and records a diagnostic", () => {
			const root = makeRoot();
			writeJson(join(root.cwd, ".senpi", "mcp.json"), { mcpServers: { shadow: { command: "evil" } } });
			const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: false });
			expect(config.servers.shadow?.state).toBe("untrusted");
			mergeExtensionMcpServers(config, [extDecl("shadow", { type: "stdio", command: "node" })]);
			expect(config.servers.shadow).toMatchObject({ source: "extension", state: "enabled" });
			expect(config.diagnostics.some((d) => d.includes("shadow") && d.includes("untrusted"))).toBe(true);
		});

		it("inserts fresh names with source extension, preserving exposure and defaulting cwd", () => {
			const root = makeRoot();
			const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
			mergeExtensionMcpServers(config, [extDecl("fresh", { type: "stdio", command: "node", exposure: "direct" })]);
			expect(config.servers.fresh).toMatchObject({ source: "extension", state: "enabled" });
			expect(config.servers.fresh?.config?.exposure).toBe("direct");
			expect(config.servers.fresh?.config?.cwd).toBe("/tmp/ext");
		});

		it("keeps configHash stable for identical declarations", () => {
			const root = makeRoot();
			const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
			mergeExtensionMcpServers(config, [extDecl("stable", { type: "stdio", command: "node" })]);
			const first = config.servers.stable?.configHash;
			delete (config.servers as Record<string, unknown>).stable;
			mergeExtensionMcpServers(config, [extDecl("stable", { type: "stdio", command: "node" })]);
			expect(config.servers.stable?.configHash).toBe(first);
		});
	});

	it("normalizes SPEC default idle and request timeouts", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				defaults: { command: "node" },
			},
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.servers.defaults.config).toMatchObject({
			idleTimeoutMin: 10,
			requestTimeoutMs: 30_000,
		});
	});

	it("validates and round-trips boolean directTools", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			mcpServers: {
				direct: {
					command: "node",
					directTools: true,
				},
			},
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.servers.direct.config).toMatchObject({
			command: "node",
			directTools: true,
		});
	});

	it("validates and round-trips output guard maxLines", () => {
		const root = makeRoot();
		writeJson(join(root.agentDir, "mcp.json"), {
			settings: {
				outputGuard: {
					maxBytes: 1000,
					maxLines: 42,
					maxTokens: 200,
				},
			},
		});

		const result = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(result.settings.outputGuard).toEqual({
			maxBytes: 1000,
			maxLines: 42,
			maxTokens: 200,
		});
	});
});
