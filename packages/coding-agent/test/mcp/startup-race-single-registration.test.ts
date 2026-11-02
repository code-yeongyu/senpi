import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import * as mcpAsync from "../../src/core/extensions/builtin/mcp/wrap.ts";
import {
	loadMcpSdkClient,
	loadMcpSdkStdioTransport,
	loadMcpSdkTypes,
} from "../../src/core/extensions/builtin/mcp/sdk.lazy.ts";
import { capturingPi, withoutMcpUtilityTools } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";
import { MrtrScript, startMrtrServer } from "./fixtures/mrtr-2026-server.ts";

// Regression for code-yeongyu/senpi#2177: when the startup-race deadline falls
// after connect() but before the backgrounded catalog refresh finishes, the
// attach pass must not list and register the catalog itself on top of the
// refresh that already owns it.

const STARTUP_DEADLINE_MS = 250;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const cleanupTasks: Array<() => Promise<void>> = [];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];
let restoreScopedTimers = () => {};

beforeEach(() => {
	delete process.env[MCP_STARTUP_TIMEOUT_ENV];
	resetMcpServiceForTests();
});

afterEach(async () => {
	restoreScopedTimers();
	restoreScopedTimers = () => {};
	vi.useRealTimers();
	if (originalStartupTimeout === undefined) delete process.env[MCP_STARTUP_TIMEOUT_ENV];
	else process.env[MCP_STARTUP_TIMEOUT_ENV] = originalStartupTimeout;
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("MCP startup race single registration (#2177)", () => {
	it("registers a deferred catalog once when the deadline lands between connect and catalog refresh", async () => {
		const root = makeRoot("startup-race-single-registration", cleanupTasks);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const requests: string[] = [];
		const script = new MrtrScript([]);
		script.tools = ["tool_1", "tool_2"].map((name) => ({ name, inputSchema: { type: "object" } }));
		script.onRequest = async (request) => {
			if (request.method !== "tools/list") return;
			requests.push(request.method);
			reached.resolve();
			await release.promise;
		};
		const server = await startMrtrServer(script);
		cleanupTasks.push(async () => {
			release.resolve();
			await server.close();
		});
		setConfig(root, {
			fx: { type: "http", url: server.url, auth: false, startupTimeoutMs: STARTUP_DEADLINE_MS },
		});
		const pi = capturingPi();
		// Control MCP deadlines only: SDK/module-runner timers and real pipes must keep progressing.
		const timers = new Map<NodeJS.Timeout, { scope: string; delayMs: number; fire: () => Promise<void> }>();
		const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
			timers.delete(timer as NodeJS.Timeout);
			realClearTimeout(timer);
		});
		const schedule = vi.spyOn(mcpAsync, "safeTimer").mockImplementation((scope, delayMs, fn, sink) => {
			const timer = realSetTimeout(() => {}, 0);
			realClearTimeout(timer);
			timers.set(timer, { scope, delayMs, fire: mcpAsync.wrapAsync(scope, fn, sink) });
			return timer;
		});
		restoreScopedTimers = () => {
			schedule.mockRestore();
			clear.mockRestore();
			for (const timer of timers.keys()) realClearTimeout(timer);
			timers.clear();
		};

		const attached = getMcpService().attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		// The first tools/list reaches the server only after connect() resolved, and
		// its reply is held: the startup connect is now inside its catalog refresh.
		await reached.promise;
		const deadline = [...timers].find(([, entry]) => entry.scope === "startup.race");
		if (!deadline) throw new Error("Startup deadline was disposed before the gated catalog completed");
		// The service may choose its non-blocking zero window; the old 250 ms advance included it.
		expect(deadline[1].delayMs).toBeLessThanOrEqual(STARTUP_DEADLINE_MS);
		timers.delete(deadline[0]);
		await deadline[1].fire();
		release.resolve();

		await attached;
		expect(await getMcpService().whenAttachSettled(15_000)).toBe("settled");
		vi.useRealTimers();

		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(requests).toEqual(["tools/list"]);
	}, 30_000);

	it("leaves an unchanged catalog registered when the connect-time relist runs", async () => {
		const root = makeRoot("startup-race-connect-relist", cleanupTasks);
		const gate = join(root.agentDir, "list-tools-gate");
		writeFileSync(gate, "open\n");
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "2", "--list-tools-gate", gate]), startupTimeoutMs: STARTUP_DEADLINE_MS },
		});
		const pi = capturingPi();
		await Promise.all([loadMcpSdkClient(), loadMcpSdkStdioTransport(), loadMcpSdkTypes()]);
		// Every connect schedules a coalesced tools-changed relist; faked timers let
		// the startup connect settle first and then fire that relist on demand.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await getMcpService().attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);

		vi.advanceTimersByTime(1_000);
		await lineCountReaches(`${gate}.requests`, 2, 15_000);
		// The relist's tools/list reply precedes both pings on the ordered stdio
		// stream, and its registration does no I/O, so a second full round trip
		// cannot complete before the relist has finished.
		const client = getMcpService().getConnection("fx")?.client;
		await client?.ping();
		await client?.ping();
		vi.useRealTimers();

		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
	}, 30_000);
});

function lineCountReaches(path: string, lines: number, timeoutMs: number): Promise<void> {
	const reached = (): boolean => existsSync(path) && readFileSync(path, "utf8").trim().split("\n").length >= lines;
	return new Promise((resolve, reject) => {
		// A directory watch reports the file appearing; appends to an existing file
		// are only reliably reported by a watch on the file itself.
		const watchers = [watch(dirname(path), check)];
		const timeout = realSetTimeout(() => {
			close();
			reject(new Error(`timed out waiting for ${lines} lines in ${path}`));
		}, timeoutMs);
		function close(): void {
			realClearTimeout(timeout);
			for (const watcher of watchers) watcher.close();
		}
		function check(): void {
			if (watchers.length === 1 && existsSync(path)) watchers.push(watch(path, check));
			if (!reached()) return;
			close();
			resolve();
		}
		check();
	});
}
