import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import {
	ServerConnection,
	type ServerConnectionStateChangedEvent,
	type ServerConnectionToolsChangedEvent,
} from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const connections: ServerConnection[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
	for (const connection of connections.splice(0).reverse()) {
		await connection.dispose();
	}
	for (const cleanup of cleanupTasks.splice(0).reverse()) {
		await cleanup();
	}
});

describe("ServerConnection state machine", () => {
	it("coalesces concurrent connect calls into one fixture spawn and emits one transition per state", async () => {
		const root = await tmpRoot("coalesce");
		const counterFile = join(root, "spawns.txt");
		const connection = createConnection("coalesce", root, ["--tools", "2", "--spawn-counter-file", counterFile]);
		connections.push(connection);
		const events = collectEvents(connection);

		const clients = await Promise.all(Array.from({ length: 10 }, () => connection.connect()));
		const listed = await clients[0]?.listTools({}, { timeout: 2000 });

		expect(connection.state).toBe("connected");
		expect(listed?.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2"]);
		expect(await readCounter(counterFile)).toBe(1);
		expect(events.state.map((event) => `${event.previousState}->${event.state}`)).toEqual([
			"idle->connecting",
			"connecting->connected",
		]);
		expect(events.tools).toHaveLength(1);
	});

	it("keeps stale slow-start connect results from overwriting a newer reload generation", async () => {
		const root = await tmpRoot("stale");
		const counterFile = join(root, "spawns.txt");
		const connection = createConnection("stale", root, [
			"--tools",
			"1",
			"--slow-start",
			"250",
			"--spawn-counter-file",
			counterFile,
		]);
		connections.push(connection);
		const events = collectEvents(connection);

		const pending = connection.connect();
		await waitForCounter(counterFile, 1);
		await connection.bumpGeneration();
		await expect(pending).rejects.toThrow(/superseded/i);

		expect(connection.state).toBe("idle");
		expect(connection.lastError).toBeUndefined();
		expect(await readCounter(counterFile)).toBe(1);
		expect(events.state.map((event) => `${event.previousState}->${event.state}`)).toEqual([
			"idle->connecting",
			"connecting->idle",
		]);
		expect(events.tools).toEqual([]);
		await assertNoFixtureProcessArg(counterFile);
	});

	it("disposes an in-flight wedged connect before the connect timeout leaks a fixture process", async () => {
		const root = await tmpRoot("dispose-pending");
		const counterFile = join(root, "spawns.txt");
		const connection = createConnection("dispose-pending", root, [
			"--wedge",
			"--spawn-counter-file",
			counterFile,
			"--slow-start",
			"10000",
		]);
		connections.push(connection);

		const pending = connection.connect();
		await waitForCounter(counterFile, 1);
		const disposeStartedAt = Date.now();
		await connection.dispose();
		const disposeElapsedMs = Date.now() - disposeStartedAt;
		await expect(pending).rejects.toThrow(/failed during connect|closed|superseded/i);

		expect(disposeElapsedMs).toBeLessThan(1500);
		expect(connection.state).toBe("disabled");
		await assertNoFixtureProcessArg(counterFile);
	});

	it("disables an in-flight wedged connect before the connect timeout leaks a fixture process", async () => {
		const root = await tmpRoot("disable-pending");
		const counterFile = join(root, "spawns.txt");
		const connection = createConnection("disable-pending", root, [
			"--wedge",
			"--spawn-counter-file",
			counterFile,
			"--slow-start",
			"10000",
		]);
		connections.push(connection);

		const pending = connection.connect();
		await waitForCounter(counterFile, 1);
		const disableStartedAt = Date.now();
		await connection.disable();
		const disableElapsedMs = Date.now() - disableStartedAt;
		await expect(pending).rejects.toThrow(/failed during connect|closed|superseded/i);

		expect(disableElapsedMs).toBeLessThan(1500);
		expect(connection.state).toBe("disabled");
		await assertNoFixtureProcessArg(counterFile);
	});

	it("moves failed connects to degraded and retains the last error for status", async () => {
		const root = await tmpRoot("failure");
		const counterFile = join(root, "spawns.txt");
		const connection = createConnection("failure", root, ["--spawn-counter-file", counterFile, "--crash-after", "0"]);
		connections.push(connection);
		const events = collectEvents(connection);

		await expect(connection.connect()).rejects.toThrow(/failure|connect|closed|crash|exited/i);

		expect(connection.state).toBe("degraded");
		expect(connection.lastError).toBeInstanceOf(Error);
		expect(connection.lastError?.message).toMatch(/failure|connect|closed|crash|exited/i);
		expect(await readCounter(counterFile)).toBe(1);
		expect(events.state.map((event) => `${event.previousState}->${event.state}`)).toEqual([
			"idle->connecting",
			"connecting->degraded",
		]);
		expect(events.tools).toEqual([]);
	});

	it("routes the transport close callback through the async guard", async () => {
		const source = await readFile("src/core/extensions/builtin/mcp/connection.ts", "utf8");

		expect(source).toContain("connection.transport.onclose = wrapAsync(");
		expect(source).not.toMatch(/connection\.transport\.onclose\s*=\s*\(\)\s*=>/);
	});

	it("fails fixture startup when the spawn counter cannot be read", async () => {
		const root = await tmpRoot("counter-read-error");
		const counterFile = join(root, "spawns.txt");
		await writeFile(counterFile, "7\n", { mode: 0o200 });
		await chmod(counterFile, 0o200);
		const connection = createConnection("counter-read-error", root, [
			"--tools",
			"1",
			"--spawn-counter-file",
			counterFile,
		]);
		connections.push(connection);

		await expect(connection.connect()).rejects.toThrow(/failed during connect|closed/i);
		await chmod(counterFile, 0o600);

		expect(connection.state).toBe("degraded");
		expect(connection.lastError).toBeInstanceOf(Error);
		expect(await readCounter(counterFile)).toBe(7);
	});

	it("supports explicit degraded, suspended, auth, registration, tools-changed, and disable seams", async () => {
		const root = await tmpRoot("seams");
		const connection = createConnection("seams", root, ["--tools", "1"]);
		connections.push(connection);
		const events = collectEvents(connection);

		connection.markDegraded(new Error("manual close"));
		connection.markSuspended(new Error("manual pause"));
		connection.markNeedsAuth(new Error("login required"));
		connection.markNeedsClientRegistration(new Error("registration required"));
		connection.markToolsChanged();
		connection.markToolsChanged();
		expect(connection.lastError?.message).toBe("registration required");
		await connection.disable();
		await expect(connection.connect()).rejects.toThrow(/disabled/i);

		expect(connection.state).toBe("disabled");
		expect(connection.lastError).toBeUndefined();
		expect(events.state.map((event) => `${event.previousState}->${event.state}`)).toEqual([
			"idle->degraded",
			"degraded->suspended",
			"suspended->needs_auth",
			"needs_auth->needs_client_registration",
			"needs_client_registration->disabled",
		]);
		expect(events.tools).toHaveLength(2);
	});
});

function createConnection(serverName: string, logDir: string, fixtureArgs: string[]): ServerConnection {
	const fixture = stdioFixtureCommand();
	return new ServerConnection({
		config: serverConfig({ args: [...fixture.args, ...fixtureArgs], command: fixture.command }),
		logger: createMcpLogger(serverName, { logDir }),
		serverName,
	});
}

function collectEvents(connection: ServerConnection): {
	state: ServerConnectionStateChangedEvent[];
	tools: ServerConnectionToolsChangedEvent[];
} {
	const state: ServerConnectionStateChangedEvent[] = [];
	const tools: ServerConnectionToolsChangedEvent[] = [];
	connection.onStateChange((event) => {
		state.push(event);
	});
	connection.onToolsChanged((event) => {
		tools.push(event);
	});
	return { state, tools };
}

async function tmpRoot(slug: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-mcp-connection-${slug}-`));
	cleanupTasks.push(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function readCounter(file: string): Promise<number> {
	const raw = await readFile(file, "utf8");
	return Number(raw.trim());
}

async function waitForCounter(file: string, expected: number): Promise<void> {
	const deadline = Date.now() + 1500;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if ((await readCounter(file)) === expected) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw lastError instanceof Error ? lastError : new Error(`counter did not reach ${expected}: ${file}`);
}

async function assertNoFixtureProcessArg(arg: string): Promise<void> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
		const hasFixture = stdout
			.split("\n")
			.some((line) => line.includes("test/mcp/fixtures/stdio-server.ts") && line.includes(arg));
		if (!hasFixture) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`fixture process still alive for arg: ${arg}`);
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
		type: "stdio",
		...overrides,
	};
}
