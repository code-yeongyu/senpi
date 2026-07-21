import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { SessionExpiredError } from "../../src/core/extensions/builtin/mcp/errors.ts";
import { withMcpSessionExpiryRetry } from "../../src/core/extensions/builtin/mcp/health.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { type HttpFixture, spawnHttpFixture, stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const connections: ServerConnection[] = [];
const httpFixtures: HttpFixture[] = [];

afterEach(async () => {
	for (const connection of connections.splice(0).reverse()) {
		await connection.dispose();
	}
	for (const fixture of httpFixtures.splice(0).reverse()) {
		await fixture.cleanup();
	}
	for (const cleanup of cleanupTasks.splice(0).reverse()) {
		await cleanup();
	}
});

describe("MCP failure diagnosis", () => {
	it("adds pre-handshake stderr to typed connection errors with token-like values redacted", async () => {
		const root = await tmpRoot("fatal-stderr");
		const connection = createStdioConnection("fatal", root, [
			"--fatal-missing-token",
			"FOO_TOKEN=super-secret-token",
		]);
		connections.push(connection);

		const error = await captureError(() => connection.connect());

		expect(error.message).toContain("FATAL: missing FOO_TOKEN=<redacted:");
		expect(error.message).not.toContain("super-secret-token");
		expect(connection.lastError?.message).toBe(error.message);
	});

	it("bounds empty-stderr diagnostic reruns at 5s for wedged commands", async () => {
		const root = await tmpRoot("wedge-rerun");
		const wrapper = await writeFirstExitThenWedgeWrapper(root);
		const connection = new ServerConnection({
			config: serverConfig({ command: process.execPath, args: [wrapper], connectTimeoutMs: 1000 }),
			logger: createMcpLogger("wedge", { logDir: root }),
			serverName: "wedge",
		});
		connections.push(connection);

		const started = performance.now();
		const error = await captureError(() => connection.connect());
		const elapsedMs = performance.now() - started;

		expect(error.message).toContain("diagnostic rerun timed out after 5000ms");
		expect(elapsedMs).toBeGreaterThanOrEqual(4800);
		expect(elapsedMs).toBeLessThan(7000);
	});

	it("explains missing stdio commands with cwd, PATH, and a repair suggestion", async () => {
		const root = await tmpRoot("missing-command");
		const connection = new ServerConnection({
			config: serverConfig({ command: "definitely-not-a-real-mcp-command", cwd: root }),
			env: { PATH: "/tmp/mcp-fixture-bin" },
			logger: createMcpLogger("missing-command", { logDir: root }),
			serverName: "missing-command",
		});
		connections.push(connection);

		const error = await captureError(() => connection.connect());

		expect(error.message).toContain("command not found: definitely-not-a-real-mcp-command");
		expect(error.message).toContain(`cwd: ${root}`);
		expect(error.message).toContain("PATH: /tmp/mcp-fixture-bin");
		expect(error.message).toContain("Install the command, add it to PATH");
	});

	it("reinitializes once for HTTP session expiry and surfaces a typed error when the retry also expires", async () => {
		const fixture = await spawnHttpFixture(["--tools", "1", "--expire-session"]);
		httpFixtures.push(fixture);
		const root = await tmpRoot("http-expiry");
		const connection = new ServerConnection({
			config: serverConfig({ type: "http", url: fixture.url }),
			logger: createMcpLogger("http-expiry", { logDir: root }),
			serverName: "http-expiry",
		});
		connections.push(connection);

		await connection.connect();
		await connection.client.listTools({}, { timeout: 2000 });
		const result = await withMcpSessionExpiryRetry(connection, () =>
			connection.client.callTool({ name: "tool_1", arguments: { value: "after-renew" } }, undefined, {
				timeout: 2000,
			}),
		);
		let forcedExpiryAttempts = 0;

		expect(toolText(result)).toBe("fixture tool_1 value=after-renew mode=alpha");
		expect(connection.generation).toBe(1);
		await expect(
			withMcpSessionExpiryRetry(connection, async () => {
				forcedExpiryAttempts += 1;
				if (forcedExpiryAttempts === 1) {
					await connection.client.callTool({ name: "tool_1", arguments: { value: "stale" } }, undefined, {
						timeout: 2000,
					});
				}
				throw mcpSessionExpiredError();
			}),
		).rejects.toBeInstanceOf(SessionExpiredError);
		expect(connection.state).toBe("suspended");
		expect(connection.lastError?.message).toContain("run /mcp reconnect http-expiry");
		expect(connection.generation).toBe(2);
	});
});

function createStdioConnection(serverName: string, logDir: string, fixtureArgs: string[]): ServerConnection {
	const fixture = stdioFixtureCommand();
	return new ServerConnection({
		config: serverConfig({ args: [...fixture.args, ...fixtureArgs], command: fixture.command }),
		logger: createMcpLogger(serverName, { logDir }),
		serverName,
	});
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(String(error));
	}
	throw new Error("expected operation to fail");
}

async function tmpRoot(slug: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-mcp-diagnose-${slug}-`));
	cleanupTasks.push(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function writeFirstExitThenWedgeWrapper(root: string): Promise<string> {
	const counterFile = join(root, "attempts.txt");
	const wrapper = join(root, "first-exit-then-wedge.mjs");
	await writeFile(
		wrapper,
		`
import { readFileSync, writeFileSync } from "node:fs";
const counterFile = ${JSON.stringify(counterFile)};
let attempts = 0;
try { attempts = Number(readFileSync(counterFile, "utf8").trim()) || 0; } catch {}
writeFileSync(counterFile, String(attempts + 1) + "\\n");
if (attempts === 0) process.exit(1);
process.stdin.resume();
setInterval(() => undefined, 60000);
`,
	);
	await chmod(wrapper, 0o755);
	return wrapper;
}

function toolText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result)) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const block = content[0];
	if (typeof block !== "object" || block === null || !("type" in block) || !("text" in block)) return "";
	return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

function mcpSessionExpiredError(): Error & { code: number } {
	const error = new Error("MCP error -32001: session expired");
	return Object.assign(error, { code: -32001 });
}

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		args: [],
		connectTimeoutMs: 2000,
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
