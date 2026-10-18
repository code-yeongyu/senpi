import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import { capturingPi, withoutMcpUtilityTools } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

// Regression for code-yeongyu/senpi#2177: when the startup-race deadline falls
// after connect() but before the backgrounded catalog refresh finishes, the
// attach pass must not list and register the catalog itself on top of the
// refresh that already owns it.

const STARTUP_DEADLINE_MS = 250;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const cleanupTasks: Array<() => Promise<void>> = [];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];

beforeEach(() => {
	delete process.env[MCP_STARTUP_TIMEOUT_ENV];
	resetMcpServiceForTests();
});

afterEach(async () => {
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
		const gate = join(root.agentDir, "list-tools-gate");
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "2", "--list-tools-gate", gate]), startupTimeoutMs: STARTUP_DEADLINE_MS },
		});
		const pi = capturingPi();
		// Only setTimeout is faked: the startup-race deadline fires exactly when the
		// test advances it, while the fixture process and its pipes run for real.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const attached = getMcpService().attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		// The first tools/list reaches the server only after connect() resolved, and
		// its reply is held: the startup connect is now inside its catalog refresh.
		await lineCountReaches(`${gate}.requests`, 1, 15_000);
		vi.advanceTimersByTime(STARTUP_DEADLINE_MS);
		writeFileSync(gate, "open\n");

		await attached;
		expect(await getMcpService().whenAttachSettled(15_000)).toBe("settled");
		vi.useRealTimers();

		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(readFileSync(`${gate}.requests`, "utf8").trim().split("\n")).toEqual(["tools/list"]);
	}, 30_000);

	it("leaves an unchanged catalog registered when the connect-time relist runs", async () => {
		const root = makeRoot("startup-race-connect-relist", cleanupTasks);
		const gate = join(root.agentDir, "list-tools-gate");
		writeFileSync(gate, "open\n");
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "2", "--list-tools-gate", gate]), startupTimeoutMs: STARTUP_DEADLINE_MS },
		});
		const pi = capturingPi();
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
