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
	type CapturingPi,
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

// attach() only blocks on the 250ms startup race (startup-race.ts: MCP_STARTUP_RACE_MS)
// before it resolves. A real fixture subprocess boot + MCP initialize handshake under a
// loaded runner routinely overruns 250ms (recovery alone measures ~300ms), so attach can
// return with the connection still "connecting"/degraded and no tools registered yet —
// any test that immediately reads the connection state or a registered tool then races
// that. Wait for the initial connect to actually reach "connected" and surface its tools
// (tool registration survives later idle shutdowns) so the test starts from a known-ready
// server instead of a half-open one.
async function attachReady(root: TestRoot, pi: CapturingPi, toolName: string): Promise<void> {
	await attach(root, pi);
	await waitForCondition(
		() => getMcpService().getConnection("fx")?.state === "connected" && pi.toolDefinitions.has(toolName),
		30_000,
	);
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
		// 0.001min (60ms) leaves the connect→idle window narrower than a loaded-runner
		// subprocess boot, so the idle timer could fire before the assertions below even
		// observe a scheduled timer. 0.02min (1.2s) keeps the test fast while giving the
		// connect and the idle-timer inspection comfortable headroom.
		setConfig(root, { fx: { ...stdioServer(["--tools", "1", "--pid-file", pidFile]), idleTimeoutMin: 0.02 } });
		const pi = capturingPi();

		await attach(root, pi);
		await waitForCondition(
			() => getMcpService().getConnection("fx")?.state === "connected" && existsSync(pidFile),
			30_000,
		);
		const pid = readNumberFile(pidFile);
		const connection = getMcpService().getConnection("fx");

		expect(connection === undefined ? undefined : getMcpLifecycleDebugSnapshot(connection)?.idleTimerHasRef).toBe(
			false,
		);
		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 10_000);

		expect(getMcpService().getServerSnapshots()).toMatchObject([{ name: "fx", lifecycleState: "idle", pid: null }]);
		await assertProcessDead(pid);
	});

	it("connects eager servers on session start and still idles them out", async () => {
		const root = mcpRoot("idle-eager");
		const pidFile = join(root.agentDir, "fixture.pid");
		// 0.02min (1.2s) keeps the connected window observable under load (a 60ms window
		// can idle out before waitForCondition below ever polls "connected"); the 30s
		// deadline clears the eager connect's real subprocess boot + handshake on a busy
		// runner instead of giving up while the connect is still in flight.
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "1", "--pid-file", pidFile]), idleTimeoutMin: 0.02, lifecycle: "eager" },
		});
		const pi = capturingPi();

		await attach(root, pi);
		await waitForCondition(
			() => getMcpService().getConnection("fx")?.state === "connected" && existsSync(pidFile),
			30_000,
		);
		const pid = readNumberFile(pidFile);

		expect(getMcpService().getServerSnapshots()).toMatchObject([{ name: "fx", lifecycleState: "connected" }]);
		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 10_000);

		expect(getMcpService().getServerSnapshots()).toMatchObject([{ name: "fx", lifecycleState: "idle", pid: null }]);
		await assertProcessDead(pid);
	});

	it("does not idle while a tool call is in flight, then idles after it completes", async () => {
		const root = mcpRoot("idle-inflight");
		const pidFile = join(root.agentDir, "fixture.pid");
		// Start from a known-connected server (attachReady) so the in-flight assertion
		// tests "an established call keeps the connection alive", not a cold reconnect; and
		// widen the idle window past 60ms so the connect settles before the call begins.
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "1", "--pid-file", pidFile, "--slow-tool-call", "250"]),
				idleTimeoutMin: 0.02,
			},
		});
		const pi = capturingPi();
		await attachReady(root, pi, "mcp_fx_tool_1");
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		const running = tool.execute("tc-slow", { value: "slow" }, undefined, undefined, testContext());
		await delay(120);

		expect(getMcpService().getConnection("fx")?.state).toBe("connected");
		expect(getMcpService().getConnection("fx")?.getRootPid()).toBe(readNumberFile(pidFile));

		const result = await running;
		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 10_000);

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
		await waitFor(() => connection.state === "idle", 10_000);

		expect(connection.state).toBe("idle");
	});

	it("reconnects transparently on the next tool call after idle shutdown", async () => {
		const root = mcpRoot("idle-reconnect");
		const pidFile = join(root.agentDir, "fixture.pid");
		// attachReady guarantees the first fixture is connected with its tool registered
		// before we read its pid; 0.02min keeps the subsequent idle-out fast but no longer
		// racing the initial connect.
		setConfig(root, { fx: { ...stdioServer(["--tools", "1", "--pid-file", pidFile]), idleTimeoutMin: 0.02 } });
		const pi = capturingPi();
		await attachReady(root, pi, "mcp_fx_tool_1");
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const firstPid = readNumberFile(pidFile);

		await waitFor(() => getMcpService().getConnection("fx")?.state === "idle", 10_000);
		const result = await tool.execute("tc-after-idle", { value: "after" }, undefined, undefined, testContext());
		const secondPid = readNumberFile(pidFile);

		expect(textContent(result)).toBe("fixture tool_1 value=after mode=alpha");
		expect(secondPid).not.toBe(firstPid);
		expect(getMcpService().getConnection("fx")?.state).toBe("connected");
	});

	it("keep-alive pings every 30 seconds and recovers a killed fixture without suspension", {
		// The recovery below spawns a *real* fixture subprocess and waits on the
		// service's real-timer reconnect backoff (see the block comment at the
		// advance/waitForRecovery call), so the wall-clock budget must clear the
		// generous recovery deadline plus attach/setup overhead on a loaded runner.
		timeout: 150_000,
	}, async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const root = mcpRoot("keep-alive-recover");
		const pidFile = join(root.agentDir, "fixture.pid");
		const pingCounterFile = join(root.agentDir, "ping-count.txt");
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "1", "--pid-file", pidFile, "--ping-counter-file", pingCounterFile]),
				// Under a parallel spawn storm on a starved CI runner, booting the fixture
				// subprocess and answering the MCP initialize handshake can take much longer
				// than the transport default (15s). If a connect attempt is killed by a tight
				// timeout, reconnect drops into a backoff-retry loop where every subsequent
				// attempt is *also* killed before it can finish, and recovery never converges
				// (observed as an eventual recovery-deadline timeout). A generous connect
				// timeout lets a slow-but-alive respawn complete on its first attempt instead.
				connectTimeoutMs: 60_000,
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
		await waitForCondition(() => existsSync(pidFile), 10_000);
		const firstPid = readNumberFile(pidFile);
		process.kill(firstPid, "SIGKILL");
		await assertProcessDead(firstPid);

		// The stdio transport's close event (which flips the connection off
		// "connected" via markDegraded) is delivered asynchronously and is NOT gated
		// on the faked keep-alive interval. Wait for that transition before ticking
		// the timer: keepAlivePingOrRecover reconnects only when the state has already
		// left "connected"; if it fires while still "connected" it merely pings the
		// dead server, and — because setInterval is faked and advanced exactly once —
		// no further tick would ever retry, wedging the recovery wait (a flake).
		await waitFor(() => connection?.state !== undefined && connection.state !== "connected", 10_000);

		expect(
			connection === undefined ? undefined : getMcpLifecycleDebugSnapshot(connection)?.keepAliveTimerHasRef,
		).toBe(false);
		// Advancing the faked keep-alive interval exercises keepAlivePingOrRecover once
		// for coverage. It is NOT what deterministically drives recovery: the service's
		// reconnect controller (reconnect.ts) reacts to the "degraded" transition on its
		// own REAL timers — a 500/1000/2000/4000/8000ms backoff chain, with a circuit
		// breaker at 5 attempts / 30s — and keeps respawning the fixture until the state
		// returns to "connected". Because that respawn is a real subprocess boot + MCP
		// initialize handshake, its wall-clock cost is load-dependent (measured ~300ms
		// unloaded but seconds under contention). So we wait on the *outcome* (a fresh,
		// connected fixture) with a deadline sized well past the generous 60s connect
		// timeout plus the 30s breaker window, and we bail out immediately if the breaker
		// trips ("suspended") so a genuine unrecoverable failure surfaces as itself rather
		// than a vague timeout.
		await vi.advanceTimersByTimeAsync(30_000);
		await waitForRecovery(
			() => {
				const currentPid = readOptionalNumberFile(pidFile);
				return (
					currentPid !== null &&
					currentPid !== firstPid &&
					connection?.state === "connected" &&
					connection.getRootPid() === currentPid &&
					pi.toolDefinitions.has("mcp_fx_tool_1")
				);
			},
			() => connection?.state === "suspended",
			90_000,
		);
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

// Wait for a reconnect-driven recovery outcome. Unlike waitFor, this fails fast
// when the reconnect circuit breaker opens ("suspended") instead of burning the
// whole deadline, so an unrecoverable fixture surfaces as a breaker failure rather
// than an opaque timeout.
async function waitForRecovery(recovered: () => boolean, suspended: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (recovered()) return;
		if (suspended()) throw new Error("reconnect circuit breaker opened before recovery (state=suspended)");
		await delay(25);
	}
	throw new Error("keep-alive recovery timed out");
}
