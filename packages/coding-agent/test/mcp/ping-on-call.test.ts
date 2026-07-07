import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecError } from "../../src/core/extensions/builtin/mcp/errors.ts";
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
	vi.useRealTimers();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

describe("MCP ping-on-call health", () => {
	it("renews a killed fixture connection on the next stale call and preserves the original call", async () => {
		const root = mcpRoot("renew-killed");
		const pidFile = join(root.agentDir, "fixture.pid");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--pid-file", pidFile]) });
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		const first = await tool.execute("tc-first", { value: "first" }, undefined, undefined, testContext());
		const firstPid = readNumberFile(pidFile);
		process.kill(firstPid, "SIGKILL");
		await assertProcessDead(firstPid);
		advanceDateOnly(31_000);

		const second = await tool.execute("tc-second", { value: "second" }, undefined, undefined, testContext());
		const secondPid = readNumberFile(pidFile);

		expect(textContent(first)).toBe("fixture tool_1 value=first mode=alpha");
		expect(textContent(second)).toBe("fixture tool_1 value=second mode=alpha");
		expect(secondPid).not.toBe(firstPid);
	});

	it("skips ping for calls inside the 30 second success window", async () => {
		const root = mcpRoot("ping-cache");
		const pingCounterFile = join(root.agentDir, "ping-count.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--ping-counter-file", pingCounterFile]) });
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		await tool.execute("tc-first", { value: "first" }, undefined, undefined, testContext());
		await tool.execute("tc-second", { value: "second" }, undefined, undefined, testContext());

		expect(readNumberFile(pingCounterFile)).toBe(1);
	});

	it("returns a bounded typed tool error when the single renewal attempt fails", async () => {
		const root = mcpRoot("renew-fails");
		const pidFile = join(root.agentDir, "fixture.pid");
		const attemptsFile = join(root.agentDir, "wrapper-attempts.txt");
		const modeFile = join(root.agentDir, "wrapper-mode.txt");
		const wrapper = writeFixtureWrapper(root, attemptsFile, modeFile);
		setConfig(root, {
			fx: {
				type: "stdio",
				command: process.execPath,
				args: [wrapper, "--tools", "1", "--pid-file", pidFile],
				connectTimeoutMs: 2000,
			},
		});
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		await tool.execute("tc-first", { value: "first" }, undefined, undefined, testContext());
		const firstPid = readNumberFile(pidFile);
		writeFileSync(modeFile, "fail\n");
		process.kill(firstPid, "SIGKILL");
		await assertProcessDead(firstPid);
		advanceDateOnly(31_000);

		await expect(
			tool.execute("tc-second", { value: "second" }, undefined, undefined, testContext()),
		).rejects.toBeInstanceOf(ToolExecError);
		expect(readNumberFile(attemptsFile)).toBe(2);
	});

	it("coalesces concurrent stale-call pings without sharing per-call arguments", async () => {
		const root = mcpRoot("concurrent-stale");
		const pingCounterFile = join(root.agentDir, "ping-count.txt");
		setConfig(root, {
			fx: stdioServer(["--tools", "1", "--slow-tool-call", "50", "--ping-counter-file", pingCounterFile]),
		});
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		const [first, second] = await Promise.all([
			tool.execute("tc-first", { value: "first" }, undefined, undefined, testContext()),
			tool.execute("tc-second", { value: "second" }, undefined, undefined, testContext()),
		]);

		expect(readNumberFile(pingCounterFile)).toBe(1);
		expect(textContent(first)).toBe("fixture tool_1 value=first mode=alpha");
		expect(textContent(second)).toBe("fixture tool_1 value=second mode=alpha");
	});
});

function advanceDateOnly(ms: number): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + ms);
}

function readNumberFile(path: string): number {
	return Number(readFileSync(path, "utf8").trim());
}

function writeFixtureWrapper(root: TestRoot, attemptsFile: string, modeFile: string): string {
	const wrapper = join(root.agentDir, "fixture-wrapper.mjs");
	mkdirSync(dirname(wrapper), { recursive: true });
	writeFileSync(modeFile, "ok\n");
	writeFileSync(
		wrapper,
		`
import { readFileSync, writeFileSync } from "node:fs";
const attemptsFile = ${JSON.stringify(attemptsFile)};
const modeFile = ${JSON.stringify(modeFile)};
let attempts = 0;
try { attempts = Number(readFileSync(attemptsFile, "utf8").trim()) || 0; } catch {}
writeFileSync(attemptsFile, String(attempts + 1) + "\\n");
if (readFileSync(modeFile, "utf8").trim() === "fail") process.exit(44);
await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "fixtures", "stdio-server.ts")).href)});
`,
	);
	chmodSync(wrapper, 0o755);
	return wrapper;
}
