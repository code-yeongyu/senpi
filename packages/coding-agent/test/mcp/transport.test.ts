import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import type { TimeoutError } from "../../src/core/extensions/builtin/mcp/errors.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	connectMcpTransport,
	createMcpTransport,
	type McpTransportConnection,
	shutdownMcpTransport,
} from "../../src/core/extensions/builtin/mcp/transport.ts";
import { assertProcessDead, spawnHttpFixture, stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const execFileAsync = promisify(execFile);
const connections: McpTransportConnection[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const connection of connections.splice(0).reverse()) {
		await shutdownMcpTransport(connection).catch(() => undefined);
	}
	for (const cleanup of cleanupTasks.splice(0).reverse()) {
		await cleanup();
	}
});

describe("MCP transport factory", () => {
	it("connects to a stdio server, lists tools, and routes stderr into the MCP logger", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-mcp-transport-"));
		cleanupTasks.push(() => rm(root, { recursive: true, force: true }));
		const logger = createMcpLogger("stdio-fixture", { logDir: root });
		const fixture = stdioFixtureCommand();
		const connection = createMcpTransport({
			config: serverConfig({ args: [...fixture.args, "--tools", "2"], command: fixture.command }),
			logger,
			serverName: "stdio-fixture",
		});
		connections.push(connection);

		expect(connection.transportKind).toBe("stdio");
		await connectMcpTransport(connection);
		const listed = await connection.client.listTools({}, { timeout: 2000 });

		expect(listed.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2"]);
		await waitFor(() => logger.getRingBuffer().some((line) => line.includes("stdio fixture ready")));
		expect(logger.getRingBuffer().some((line) => line.includes('"channel":"stderr"'))).toBe(true);
		expect(readFileSync(logger.filePath, "utf8")).toContain('"channel":"stderr"');
	});

	it("wraps slow stdio startup in a typed TimeoutError and leaves no child process", async () => {
		const logger = createMcpLogger("slow-stdio", { logDir: await mkdtemp(join(tmpdir(), "senpi-mcp-transport-")) });
		const fixture = stdioFixtureCommand();
		const connection = createMcpTransport({
			config: serverConfig({
				args: [...fixture.args, "--slow-start", "30000"],
				command: fixture.command,
				connectTimeoutMs: 1000,
			}),
			logger,
			serverName: "slow-stdio",
		});
		connections.push(connection);

		const started = performance.now();
		await expect(connectMcpTransport(connection)).rejects.toMatchObject({
			name: "TimeoutError",
			serverName: "slow-stdio",
			phase: "connect",
		} satisfies Partial<TimeoutError>);
		expect(performance.now() - started).toBeLessThan(2500);

		const pid = connection.getRootPid();
		if (pid !== null) await assertProcessDead(pid);
	});

	it("reaps a stdio process tree during shutdown", async () => {
		const logger = createMcpLogger("tree-stdio", { logDir: await mkdtemp(join(tmpdir(), "senpi-mcp-transport-")) });
		const fixture = stdioFixtureCommand();
		const connection = createMcpTransport({
			config: serverConfig({ args: [...fixture.args, "--spawn-grandchild"], command: fixture.command }),
			logger,
			serverName: "tree-stdio",
		});
		connections.push(connection);
		await connectMcpTransport(connection);

		const rootPid = connection.getRootPid();
		if (rootPid === null) throw new Error("stdio transport did not expose a root pid");
		const childPids = await waitForChildPids(rootPid);

		await shutdownMcpTransport(connection);
		connections.pop();

		await assertProcessDead(rootPid);
		for (const childPid of childPids) await assertProcessDead(childPid);
	});

	it("connects to a streamable HTTP server and lists tools", async () => {
		const fixture = await spawnHttpFixture(["--tools", "3"]);
		cleanupTasks.push(fixture.cleanup);
		const logger = createMcpLogger("http-fixture", { logDir: await mkdtemp(join(tmpdir(), "senpi-mcp-transport-")) });
		const connection = createMcpTransport({
			config: serverConfig({ type: "http", url: fixture.url }),
			logger,
			serverName: "http-fixture",
		});
		connections.push(connection);

		expect(connection.transportKind).toBe("http");
		await connectMcpTransport(connection);
		const listed = await connection.client.listTools({}, { timeout: 2000 });

		expect(listed.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2", "tool_3"]);
	});

	it("rejects malformed stdio commands and HTTP URLs with typed connect errors", () => {
		const logger = createMcpLogger("bad-config");

		expect(() =>
			createMcpTransport({ config: serverConfig({ command: "   " }), logger, serverName: "bad-stdio" }),
		).toThrow(/bad-stdio.*command/i);
		expect(() =>
			createMcpTransport({
				config: serverConfig({ type: "http", url: "nota url" }),
				logger,
				serverName: "bad-http",
			}),
		).toThrow(/bad-http.*URL/i);
	});
});

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		args: [],
		connectTimeoutMs: 15_000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "lazy",
		logLevel: "info",
		requestTimeoutMs: 30_000,
		startupTimeoutMs: 250,
		type: "stdio",
		...overrides,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition was not met before timeout");
}

async function waitForChildPids(rootPid: number): Promise<number[]> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		const pids = await childPids(rootPid);
		if (pids.length > 0) return pids;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`no child pids found for ${rootPid}`);
}

async function childPids(parentPid: number): Promise<number[]> {
	if (!["darwin", "linux"].includes(process.platform)) return [];
	try {
		const { stdout } = await execFileAsync("pgrep", ["-P", String(parentPid)], { timeout: 1000 });
		return stdout
			.split(/\s+/)
			.map((pid) => Number(pid))
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch (error) {
		ignoreExpectedProcessRace(error);
		return [];
	}
}

function ignoreExpectedProcessRace(error: unknown): void {
	void error;
}
