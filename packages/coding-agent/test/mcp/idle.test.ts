import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "../../src/core/extensions/builtin/mcp/config.ts";
import {
	getMcpLifecycleDebugSnapshot,
	runMcpConnectionLifecycleCall,
} from "../../src/core/extensions/builtin/mcp/idle.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	capturingPi,
	mcpRoot as makeMcpRoot,
	registeredTool,
	testContext,
	textContent,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot, waitForCondition } from "./fixtures/service-lifecycle.ts";
import { assertProcessDead } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	vi.useRealTimers();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

describe("MCP idle lifecycle", () => {
	it("characterizes the default idle timeout as 10 minutes", () => {
		const root = mcpRoot("default-timeout");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });

		const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });

		expect(config.servers.fx?.config?.idleTimeoutMin).toBe(10);
	});

	it("shuts down a connected zero-in-flight server after the configured idle window", async () => {
		const root = mcpRoot("idle-zero-inflight");
		const pidFile = join(root.agentDir, "fixture.pid");
		setConfig(root, { fx: { ...stdioServer(["--tools", "1", "--pid-file", pidFile]), idleTimeoutMin: 0.001 } });
		const pi = capturingPi();

		await attach(root, pi);
		const pid = readNumberFile(pidFile);
		const connection = getMcpService().getConnection("fx");

		expect(connection === undefined ? undefined : getMcpLifecycleDebugSnapshot(connection)?.idleTimerHasRef).toBe(
			false,
		);
		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 1500);

		expect(getMcpService().getServerSnapshots()).toMatchObject([{ name: "fx", lifecycleState: "idle", pid: null }]);
		await assertProcessDead(pid);
	});

	it("connects eager servers on session start and still idles them out", async () => {
		const root = mcpRoot("idle-eager");
		const pidFile = join(root.agentDir, "fixture.pid");
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "1", "--pid-file", pidFile]), idleTimeoutMin: 0.001, lifecycle: "eager" },
		});
		const pi = capturingPi();

		await attach(root, pi);
		await waitForCondition(
			() => getMcpService().getConnection("fx")?.state === "connected" && existsSync(pidFile),
			2500,
		);
		const pid = readNumberFile(pidFile);

		expect(getMcpService().getServerSnapshots()).toMatchObject([{ name: "fx", lifecycleState: "connected" }]);
		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 1500);

		expect(getMcpService().getServerSnapshots()).toMatchObject([{ name: "fx", lifecycleState: "idle", pid: null }]);
		await assertProcessDead(pid);
	});

	it("does not idle while a tool call is in flight, then idles after it completes", async () => {
		const root = mcpRoot("idle-inflight");
		const pidFile = join(root.agentDir, "fixture.pid");
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "1", "--pid-file", pidFile, "--slow-tool-call", "250"]),
				idleTimeoutMin: 0.001,
			},
		});
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		const running = tool.execute("tc-slow", { value: "slow" }, undefined, undefined, testContext());
		await delay(120);

		expect(getMcpService().getConnection("fx")?.state).toBe("connected");
		expect(getMcpService().getConnection("fx")?.getRootPid()).toBe(readNumberFile(pidFile));

		const result = await running;
		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 1500);

		expect(textContent(result)).toBe("fixture tool_1 value=slow mode=alpha");
	});

	it("keeps the idle timer paused while a renewal is in flight", async () => {
		const root = mcpRoot("idle-renewal");
		setConfig(root, { fx: { ...stdioServer(["--tools", "1"]), idleTimeoutMin: 0.001 } });
		const pi = capturingPi();
		await attach(root, pi);
		const connection = getMcpService().getConnection("fx");
		if (connection === undefined) throw new Error("missing fx connection");

		await runMcpConnectionLifecycleCall(connection, async () => {
			await connection.renew();
			await delay(120);
			expect(connection.state).toBe("connected");
		});
		await waitFor(() => connection.state === "idle", 1500);

		expect(connection.state).toBe("idle");
	});

	it("reconnects transparently on the next tool call after idle shutdown", async () => {
		const root = mcpRoot("idle-reconnect");
		const pidFile = join(root.agentDir, "fixture.pid");
		setConfig(root, { fx: { ...stdioServer(["--tools", "1", "--pid-file", pidFile]), idleTimeoutMin: 0.001 } });
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const firstPid = readNumberFile(pidFile);

		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 1500);
		const result = await tool.execute("tc-after-idle", { value: "after" }, undefined, undefined, testContext());
		const secondPid = readNumberFile(pidFile);

		expect(textContent(result)).toBe("fixture tool_1 value=after mode=alpha");
		expect(secondPid).not.toBe(firstPid);
		expect(getMcpService().getConnection("fx")?.state).toBe("connected");
	});

	it("keep-alive pings every 30 seconds and recovers a killed fixture without suspension", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const root = mcpRoot("keep-alive-recover");
		const pidFile = join(root.agentDir, "fixture.pid");
		const pingCounterFile = join(root.agentDir, "ping-count.txt");
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "1", "--pid-file", pidFile, "--ping-counter-file", pingCounterFile]),
				lifecycle: "keep-alive",
			},
		});
		const pi = capturingPi();
		await attach(root, pi);
		const connection = getMcpService().getConnection("fx");
		const states: string[] = [];
		connection?.onStateChange((event) => {
			states.push(event.state);
		});
		await waitForCondition(() => existsSync(pidFile), 2500);
		const firstPid = readNumberFile(pidFile);
		process.kill(firstPid, "SIGKILL");
		await assertProcessDead(firstPid);

		expect(
			connection === undefined ? undefined : getMcpLifecycleDebugSnapshot(connection)?.keepAliveTimerHasRef,
		).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		await waitFor(() => {
			const currentPid = readOptionalNumberFile(pidFile);
			return (
				currentPid !== null &&
				currentPid !== firstPid &&
				connection?.state === "connected" &&
				connection.getRootPid() === currentPid &&
				pi.toolDefinitions.has("mcp_fx_tool_1")
			);
		}, 5000);
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const result = await tool.execute("tc-keep-alive", { value: "recovered" }, undefined, undefined, testContext());

		expect(readNumberFile(pingCounterFile)).toBeGreaterThanOrEqual(1);
		expect(textContent(result)).toBe("fixture tool_1 value=recovered mode=alpha");
		expect(states).not.toContain("suspended");
		expect(getMcpService().getServerSnapshots()).toMatchObject([
			{ name: "fx", lifecycleState: "connected", lastError: null },
		]);
	});
});

function readNumberFile(path: string): number {
	return Number(readFileSync(path, "utf8").trim());
}

function readOptionalNumberFile(path: string): number | null {
	try {
		const value = readNumberFile(path);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (assertion()) return;
		await delay(25);
	}
	throw new Error("condition timed out");
}
