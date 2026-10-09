import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { getMcpService, McpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import { capturingPi } from "./fixtures/register-call.ts";
import {
	cleanupRoots,
	makeRoot,
	setConfig,
	stdioServer,
	type TestRoot,
	waitForCondition,
} from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];

beforeEach(() => {
	resetMcpServiceForTests();
	// Force the startup race to defer every connect (0 = non-blocking window), so the
	// catalog write is always backgrounded past attach regardless of an ambient
	// SENPI_MCP_STARTUP_TIMEOUT_MS override; without this the scenario depends on the
	// fixture's slow start outlasting whatever window the environment configured.
	process.env[MCP_STARTUP_TIMEOUT_ENV] = "0";
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	restoreEnv(ENV_AGENT_DIR, originalAgentDir);
	restoreEnv(MCP_STARTUP_TIMEOUT_ENV, originalStartupTimeout);
	await cleanupRoots(cleanupTasks);
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

describe("MCP catalog cache agent-dir binding", () => {
	it("writes the backgrounded catalog cache under the attach-time agent dir when the env changes mid-attach", async () => {
		const rootA = makeRoot("catalog-cache-dir-a", cleanupTasks);
		setConfig(rootA, { fx: stdioServer(["--tools", "1", "--slow-start", "600"]) });
		const rootB = makeRoot("catalog-cache-dir-b", cleanupTasks);

		// Default attach path (what interactive/RPC sessions take): no explicit
		// agentDir option, so the connection entry inherits the env-resolved
		// directory captured at attach time.
		process.env[ENV_AGENT_DIR] = rootA.agentDir;
		const service = new McpService();
		try {
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: rootA.cwd, isProjectTrusted: () => true },
				capturingPi(),
			);

			// The non-blocking startup window backgrounded the slow fixture connect: attach
			// returned before the catalog write. Prove the deferral, then flip the env to dir
			// B before that write resolves.
			expect(
				existsSync(cachePath(rootA)) || existsSync(cachePath(rootB)),
				"connect must be deferred past attach",
			).toBe(false);
			process.env[ENV_AGENT_DIR] = rootB.agentDir;

			await waitForCondition(() => existsSync(cachePath(rootA)) || existsSync(cachePath(rootB)), 10_000);
			expect(existsSync(cachePath(rootB)), "catalog cache must never land in the write-time env dir B").toBe(false);
			expect(existsSync(cachePath(rootA)), "catalog cache must land in the attach-time dir A").toBe(true);

			const cache = JSON.parse(await readFile(cachePath(rootA), "utf8")) as {
				servers: Record<string, { tools: Array<{ name: string }> }>;
			};
			expect(cache.servers.fx?.tools.map((tool) => tool.name)).toEqual(["tool_1"]);
		} finally {
			await service.dispose("quit");
		}
	});
});

function cachePath(root: TestRoot): string {
	return join(root.agentDir, "cache", "mcp-cache.json");
}
