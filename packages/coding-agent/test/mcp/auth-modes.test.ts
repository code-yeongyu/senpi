import { afterEach, describe, expect, it } from "vitest";
import {
	detectLiteralBearerWarnings,
	resolveAuthMode,
	resolveServerAuth,
} from "../../src/core/extensions/builtin/mcp/auth/context.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	connectMcpTransport,
	createMcpTransport,
	type McpTransportConnection,
	shutdownMcpTransport,
} from "../../src/core/extensions/builtin/mcp/transport.ts";
import { spawnHttpFixture } from "./fixtures/spawn-fixture.ts";
import { spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const connections: McpTransportConnection[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => shutdownMcpTransport(connection)));
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function baseHttp(url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		type: "http",
		url,
		args: [],
		enabled: true,
		lifecycle: "lazy",
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		idleTimeoutMin: 10,
		exposure: "auto",
		logLevel: "info",
		...extra,
	};
}

async function connect(
	config: McpServerConfig,
	env?: Record<string, string | undefined>,
): Promise<McpTransportConnection> {
	const connection = createMcpTransport({ config, env, logger: createMcpLogger("auth-modes"), serverName: "srv" });
	connections.push(connection);
	await connectMcpTransport(connection);
	return connection;
}

describe("mcp auth mode autodetect (#158)", () => {
	it("resolves the auth mode from explicit override and header presence", () => {
		expect(resolveAuthMode(baseHttp("https://x/mcp"))).toBe("oauth");
		expect(resolveAuthMode(baseHttp("https://x/mcp", { auth: "oauth" }))).toBe("oauth");
		expect(resolveAuthMode(baseHttp("https://x/mcp", { auth: false }))).toBe("none");
		expect(resolveAuthMode(baseHttp("https://x/mcp", { auth: "bearer", bearerTokenEnv: "T" }))).toBe("bearer");
		expect(resolveAuthMode(baseHttp("https://x/mcp", { bearerTokenEnv: "T" }))).toBe("bearer");
		// Headers present => autodetect OFF (API-key servers must not trigger DCR).
		expect(resolveAuthMode(baseHttp("https://x/mcp", { headers: { Authorization: "Bearer k" } }))).toBe("none");
		expect(resolveAuthMode({ ...baseHttp(""), type: "stdio", url: undefined, command: "x" })).toBe("none");
	});

	it("connects a header-auth server with zero OAuth machinery", async () => {
		const token = "ctx7-static-key";
		const fixture = await spawnHttpFixture(["--bearer", token, "--tools", "1"]);
		cleanups.push(fixture.cleanup);
		const connection = await connect(
			baseHttp(fixture.url, { auth: false, headers: { Authorization: `Bearer ${token}` } }),
		);
		const tools = await connection.client.listTools({}, { timeout: 3000 });
		expect(tools.tools.length).toBeGreaterThan(0);
	});

	it("never contacts OAuth discovery endpoints when headers are configured", async () => {
		const idp = await spawnOAuthIdp();
		cleanups.push(idp.cleanup);
		const config = baseHttp(idp.mcpUrl, { headers: { Authorization: "Bearer not-a-real-token" } });
		expect(resolveAuthMode(config)).toBe("none");
		await expect(connect(config)).rejects.toThrow();
		const log = await idp.getLog();
		expect(log.discoveryHits).toBe(0);
		expect(log.requests).toHaveLength(0);
	});

	it("resolves bearerTokenEnv at connect time (env change is picked up)", async () => {
		const token = "env-token-1";
		const fixture = await spawnHttpFixture(["--bearer", token, "--tools", "1"]);
		cleanups.push(fixture.cleanup);
		const config = baseHttp(fixture.url, { bearerTokenEnv: "MCP_TOKEN" });
		const ok = await connect(config, { MCP_TOKEN: token });
		expect((await ok.client.listTools({}, { timeout: 3000 })).tools.length).toBeGreaterThan(0);
		// A different env value is rejected by the server -> proves per-connect resolution.
		await expect(connect(config, { MCP_TOKEN: "stale-token" })).rejects.toThrow();
	});

	it("fails fast with an actionable error when bearerTokenEnv is unset", () => {
		const config = baseHttp("https://x/mcp", { auth: "bearer", bearerTokenEnv: "MISSING_VAR" });
		expect(() => createMcpTransport({ config, env: {}, logger: createMcpLogger("srv"), serverName: "srv" })).toThrow(
			/MISSING_VAR is not set/,
		);
	});

	it("lets explicit auth false override bearerTokenEnv", () => {
		const config = baseHttp("https://x/mcp", { auth: false, bearerTokenEnv: "MISSING_VAR" });
		const connection = createMcpTransport({ config, env: {}, logger: createMcpLogger("srv"), serverName: "srv" });
		connections.push(connection);
		expect(connection.transportKind).toBe("http");
	});

	it("warns on a literal secret in headers and suggests an env var placeholder", () => {
		const literal = detectLiteralBearerWarnings(
			"srv",
			baseHttp("https://x/mcp", { headers: { Authorization: "Bearer sk-live-abc123" } }),
		);
		expect(literal).toHaveLength(1);
		expect(literal[0]).toContain("stays out of the config file");
		const envRef = `Bearer $${"{TOKEN}"}`;
		const interpolated = detectLiteralBearerWarnings(
			"srv",
			baseHttp("https://x/mcp", { headers: { Authorization: envRef } }),
		);
		expect(interpolated).toHaveLength(0);
	});

	it("marks an unauthenticated OAuth server as needs_auth (not degraded)", async () => {
		const idp = await spawnOAuthIdp();
		cleanups.push(idp.cleanup);
		const dir = `${process.env.SENPI_CODING_AGENT_DIR}/needs-auth-${Date.now()}`;
		const config = baseHttp(idp.mcpUrl);
		const plan = resolveServerAuth({ agentDir: dir, config, serverName: "na" });
		const connection = new ServerConnection({
			serverName: "na",
			config,
			logger: createMcpLogger("na"),
			authProvider: plan.provider,
		});
		await connection.connect().catch(() => undefined);
		expect(connection.state).toBe("needs_auth");
		await connection.dispose();
	});

	it("logs auth material as fingerprints only, never the raw token", () => {
		const logger = createMcpLogger("srv");
		logger.info("connecting", { headers: { authorization: "Bearer super-secret-token-value" } });
		const dump = logger.getRingBuffer().join("\n");
		expect(dump).not.toContain("super-secret-token-value");
		expect(dump).toMatch(/<redacted:[0-9a-f]{8}>/);
	});
});
