import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	configureMcpReconnect,
	disposeMcpReconnect,
	getMcpReconnectDebugSnapshot,
} from "../../src/core/extensions/builtin/mcp/reconnect.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	capturingPi,
	mcpRoot as makeMcpRoot,
	registeredTool,
	testContext,
	textContent,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";
import { assertProcessDead } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

describe("MCP auto reconnect", () => {
	it("schedules jittered reconnect timers inside the expected backoff bound", async () => {
		vi.useFakeTimers();
		const root = mcpRoot("jitter");
		const connection = new ServerConnection({
			config: serverConfig(),
			logger: createMcpLogger("jitter", { logDir: root.agentDir }),
			serverName: "jitter",
		});
		let attempts = 0;
		configureMcpReconnect({
			connection,
			logger: createMcpLogger("jitter-reconnect", { logDir: root.agentDir }),
			random: () => 0.5,
			reconnect: async () => {
				attempts += 1;
			},
		});

		connection.markDegraded(new Error("closed"));

		expect(getMcpReconnectDebugSnapshot(connection).timerHasRef).toBe(false);
		await vi.advanceTimersByTimeAsync(249);
		expect(attempts).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toBe(1);

		disposeMcpReconnect(connection);
	});

	it("reconnects after an unexpected close with jittered backoff", async () => {
		const root = mcpRoot("unexpected-close");
		const counterFile = join(root.agentDir, "spawn-count.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile, "--crash-after", "1"]) });
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		const first = await tool.execute("tc-first", { value: "first" }, undefined, undefined, testContext());
		await waitFor(
			() => getMcpService().getConnection("fx")?.state === "connected" && readNumberFile(counterFile) >= 2,
		);

		expect(textContent(first)).toBe("fixture tool_1 value=first mode=alpha");
		expect(readNumberFile(counterFile)).toBe(2);
	});

	it("opens the circuit after five reconnect attempts in thirty seconds", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const root = mcpRoot("breaker");
		const counterFile = join(root.agentDir, "spawn-count.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile, "--crash-after", "0"]) });
		const pi = capturingPi();
		await attach(root, pi);

		await waitFor(() => getMcpService().getConnection("fx")?.state === "suspended");
		await delay(500);

		expect(readNumberFile(counterFile)).toBeLessThanOrEqual(6);
		expect(getMcpService().getServerSnapshots()).toMatchObject([
			{
				name: "fx",
				lifecycleState: "suspended",
				lastError: expect.stringMatching(/circuit breaker|reconnect/i),
				counters: expect.objectContaining({ reconnectCount: 5 }),
			},
		]);
	});

	it("manual reconnect resets the circuit breaker and reconnects immediately", async () => {
		const root = mcpRoot("manual");
		const counterFile = join(root.agentDir, "spawn-count.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
		const pi = capturingPi();
		await attach(root, pi);
		const connection = getMcpService().getConnection("fx");
		if (connection === undefined) throw new Error("missing fx connection");
		connection.markSuspended(new Error("test breaker open"));

		await reconnectCapableService().reconnectServer("fx");

		expect(getMcpService().getConnection("fx")?.state).toBe("connected");
		expect(readNumberFile(counterFile)).toBe(2);
	});

	it("does not duplicate a tool call that was in flight when the transport died", async () => {
		const root = mcpRoot("inflight");
		const counterFile = join(root.agentDir, "call-count.txt");
		setConfig(root, {
			fx: stdioServer([
				"--tools",
				"1",
				"--call-counter-file",
				counterFile,
				"--crash-during-tool-call",
				"--slow-tool-call",
				"50",
			]),
		});
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		await expect(tool.execute("tc-crash", { value: "once" }, undefined, undefined, testContext())).rejects.toThrow(
			/ToolExecError/,
		);

		expect(readNumberFile(counterFile)).toBe(1);
	});

	it("reconnects and retries a retriable failed-to-send tool call exactly once", async () => {
		const root = mcpRoot("failed-send-retry");
		const spawnCounterFile = join(root.agentDir, "spawn-count.txt");
		const callCounterFile = join(root.agentDir, "call-count.txt");
		setConfig(root, {
			fx: stdioServer([
				"--tools",
				"1",
				"--spawn-counter-file",
				spawnCounterFile,
				"--call-counter-file",
				callCounterFile,
			]),
		});
		const pi = capturingPi();
		await attach(root, pi);
		const connection = getMcpService().getConnection("fx");
		if (connection === undefined) throw new Error("missing fx connection");
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const initialGeneration = connection.generation;
		const firstClient = connection.client;
		let failedSendAttempts = 0;
		firstClient.callTool = async () => {
			failedSendAttempts += 1;
			throw new Error("transport closed before write");
		};

		const result = await tool.execute("tc-failed-send", { value: "retried" }, undefined, undefined, testContext());

		expect(textContent(result)).toBe("fixture tool_1 value=retried mode=alpha");
		expect(failedSendAttempts).toBe(1);
		expect(connection.generation).toBe(initialGeneration + 1);
		expect(readNumberFile(spawnCounterFile)).toBe(2);
		expect(readNumberFile(callCounterFile)).toBe(1);
	});

	it("surfaces a retriable failed-to-send retry failure without looping", async () => {
		const root = mcpRoot("failed-send-retry-fails");
		const spawnCounterFile = join(root.agentDir, "spawn-count.txt");
		const callCounterFile = join(root.agentDir, "call-count.txt");
		setConfig(root, {
			fx: stdioServer([
				"--tools",
				"1",
				"--spawn-counter-file",
				spawnCounterFile,
				"--call-counter-file",
				callCounterFile,
			]),
		});
		const pi = capturingPi();
		await attach(root, pi);
		const connection = getMcpService().getConnection("fx");
		if (connection === undefined) throw new Error("missing fx connection");
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const originalRenew = connection.renew.bind(connection);
		let firstSendFailures = 0;
		let retrySendFailures = 0;
		vi.spyOn(connection, "renew").mockImplementation(async () => {
			const renewedClient = await originalRenew();
			renewedClient.callTool = async () => {
				retrySendFailures += 1;
				throw new Error("transport closed after reconnect");
			};
			return renewedClient;
		});
		connection.client.callTool = async () => {
			firstSendFailures += 1;
			throw new Error("transport closed before write");
		};

		await expect(
			tool.execute("tc-retry-fails", { value: "never" }, undefined, undefined, testContext()),
		).rejects.toThrow(/ToolExecError: Error: transport closed after reconnect/);

		expect(firstSendFailures).toBe(1);
		expect(retrySendFailures).toBe(1);
		expect(connection.renew).toHaveBeenCalledTimes(1);
		expect(readNumberFile(spawnCounterFile)).toBe(2);
		expect(readNumberFileOrZero(callCounterFile)).toBe(0);
	});

	it("sends a queued call exactly once after reconnecting a dead transport", async () => {
		const root = mcpRoot("queued");
		const pidFile = join(root.agentDir, "fixture.pid");
		const callCounterFile = join(root.agentDir, "call-count.txt");
		setConfig(root, {
			fx: stdioServer(["--tools", "1", "--pid-file", pidFile, "--call-counter-file", callCounterFile]),
		});
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const firstPid = readNumberFile(pidFile);
		process.kill(firstPid, "SIGKILL");
		await assertProcessDead(firstPid);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 31_000);

		const result = await tool.execute("tc-after-crash", { value: "after" }, undefined, undefined, testContext());

		expect(textContent(result)).toBe("fixture tool_1 value=after mode=alpha");
		expect(readNumberFile(callCounterFile)).toBe(1);
	});
});

function readNumberFile(path: string): number {
	return Number(readFileSync(path, "utf8").trim());
}

function readNumberFileOrZero(path: string): number {
	try {
		return readNumberFile(path);
	} catch (error) {
		if (isNodeErrorCode(error, "ENOENT")) return 0;
		throw error;
	}
}

function isNodeErrorCode(error: unknown, code: string): error is Error & { code: string } {
	return error instanceof Error && "code" in error && error.code === code;
}

function reconnectCapableService(): { reconnectServer(name: string): Promise<void> } {
	return getMcpService() as unknown as { reconnectServer(name: string): Promise<void> };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverConfig(): McpServerConfig {
	return {
		args: [],
		command: process.execPath,
		connectTimeoutMs: 2000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "lazy",
		logLevel: "info",
		requestTimeoutMs: 30_000,
		type: "stdio",
	};
}

async function waitFor(assertion: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (assertion()) return;
		} catch (error) {
			lastError = error;
		}
		await delay(25);
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("condition timed out");
}
