// Some MCP servers end pagination with `nextCursor: null` instead of omitting
// the cursor; the catalog must list their tools instead of failing.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectToolCatalog } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function stdioConnection(
	fixtureArgs: string[],
): Promise<{ connection: ServerConnection; config: McpServerConfig }> {
	const logDir = await mkdtemp(join(tmpdir(), "mcp-null-cursor-"));
	cleanups.push(() => rm(logDir, { force: true, recursive: true }));
	const fixture = stdioFixtureCommand();
	const config: McpServerConfig = {
		type: "stdio",
		command: fixture.command,
		args: [...fixture.args, ...fixtureArgs],
		enabled: true,
		lifecycle: "lazy",
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		startupTimeoutMs: 250,
		idleTimeoutMin: 10,
		exposure: "auto",
		logLevel: "info",
	};
	const connection = new ServerConnection({ config, logger: createMcpLogger("fx", { logDir }), serverName: "fx" });
	cleanups.push(() => connection.dispose());
	return { connection, config };
}

describe("MCP list pagination end markers", () => {
	it("lists every tool of a server that ends pagination with a null cursor", async () => {
		const { connection, config } = await stdioConnection(["--tools", "2", "--null-next-cursor"]);
		await connection.connect();

		const catalog = await collectToolCatalog("fx", connection, config);

		expect(catalog.map((entry) => entry.tool)).toEqual(["tool_1", "tool_2"]);
	});
});
