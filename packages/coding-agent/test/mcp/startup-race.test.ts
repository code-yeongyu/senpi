import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/extensions/builtin/mcp/config.ts";
import { ConnectError, ToolExecError } from "../../src/core/extensions/builtin/mcp/errors.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	capturingPi,
	registeredTool,
	testContext,
	textContent,
	withoutMcpUtilityTools,
} from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("MCP startup race", () => {
	it("eventually registers live tools when an eager server starts without cache", async () => {
		const root = makeStartupRoot("fast-eager");
		setConfig(root, { fx: { ...stdioServer(["--tools", "2"]), lifecycle: "eager" } });
		const pi = capturingPi();

		await attach(root, pi);
		await waitFor(() => withoutMcpUtilityTools(pi.registeredTools).length === 2, 2500);

		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(getMcpService().getServerSnapshots()).toMatchObject([
			{ name: "fx", lifecycleState: "connected", configState: "enabled" },
		]);
	});

	it("returns in under 300ms for a slow eager server while registering cached tools", async () => {
		const root = makeStartupRoot("slow-cache");
		setConfig(root, { fx: { ...stdioServer(["--tools", "2", "--slow-start", "5000"]), lifecycle: "eager" } });
		writeCache(root, { fx: cachedServer(root, "fx", ["tool_1"]) });
		const pi = capturingPi();

		const elapsedMs = await timedAttach(root, pi);

		expect(elapsedMs).toBeLessThan(300);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1"]);
		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1"]);
		expect(getMcpService().getServerSnapshots()).toMatchObject([
			{ name: "fx", lifecycleState: "connecting", configState: "enabled" },
		]);
	});

	it("uses the same cached startup race path for slow keep-alive servers", async () => {
		const root = makeStartupRoot("keep-alive-cache");
		setConfig(root, { fx: { ...stdioServer(["--tools", "1", "--slow-start", "5000"]), lifecycle: "keep-alive" } });
		writeCache(root, { fx: cachedServer(root, "fx", ["tool_1"]) });
		const pi = capturingPi();

		const elapsedMs = await timedAttach(root, pi);

		expect(elapsedMs).toBeLessThan(300);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1"]);
		expect(getMcpService().getServerSnapshots()).toMatchObject([
			{ name: "fx", lifecycleState: "connecting", configState: "enabled" },
		]);
	});

	it("hot-swaps cached eager tools after the late connection refreshes the catalog", async () => {
		const root = makeStartupRoot("hot-swap");
		setConfig(root, { fx: { ...stdioServer(["--tools", "2", "--slow-start", "500"]), lifecycle: "eager" } });
		writeCache(root, { fx: cachedServer(root, "fx", ["tool_1"]) });
		const pi = capturingPi();

		await attach(root, pi);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1"]);

		await waitFor(() => withoutMcpUtilityTools(pi.activeTools).includes("mcp_fx_tool_2"), 2500);

		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		const tool = registeredTool(pi, "mcp_fx_tool_2");
		const result = await tool.execute("tc-hot-swap", { value: "late" }, undefined, undefined, testContext());
		expect(textContent(result)).toBe("fixture tool_2 value=late mode=alpha");
		const cache = await readCache(root);
		expect(cache.servers.fx.tools.map((item) => item.name)).toEqual(["tool_1", "tool_2"]);
	});

	it("keeps unchanged cached tool arrays byte-identical across late refresh", async () => {
		const root = makeStartupRoot("stable-refresh");
		setConfig(root, { fx: { ...stdioServer(["--tools", "2", "--slow-start", "500"]), lifecycle: "eager" } });
		writeCache(root, { fx: cachedServer(root, "fx", ["tool_1", "tool_2"]) });
		const pi = capturingPi();

		await attach(root, pi);
		const before = JSON.stringify(withoutMcpUtilityTools(pi.activeTools));

		await waitFor(() => getMcpService().getConnection("fx")?.state === "connected", 2500);
		const after = JSON.stringify(withoutMcpUtilityTools(pi.activeTools));

		expect(after).toBe(before);
		expect(before).toBe(JSON.stringify(["mcp_fx_tool_1", "mcp_fx_tool_2"]));
	});

	it("keeps cached tools for wedged eager servers and returns a typed ConnectError without hanging", async () => {
		const root = makeStartupRoot("wedge-cache");
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "1", "--wedge"]), lifecycle: "eager", connectTimeoutMs: 500 },
		});
		writeCache(root, { fx: cachedServer(root, "fx", ["tool_1"]) });
		const pi = capturingPi();

		const attachElapsedMs = await timedAttach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const callStartedAt = performance.now();
		const call = tool.execute("tc-wedge", { value: "wedge" }, undefined, undefined, testContext());

		await expect(call).rejects.toSatisfy((error: unknown) => {
			return error instanceof ToolExecError && getErrorCause(error) instanceof ConnectError;
		});
		const callElapsedMs = performance.now() - callStartedAt;

		expect(attachElapsedMs).toBeLessThan(300);
		expect(callElapsedMs).toBeLessThan(30_000);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1"]);
	});
});

async function attach(root: TestRoot, pi = capturingPi()): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
}

async function timedAttach(root: TestRoot, pi: ReturnType<typeof capturingPi>): Promise<number> {
	const startedAt = performance.now();
	await attach(root, pi);
	return performance.now() - startedAt;
}

function makeStartupRoot(slug: string): TestRoot {
	return makeRoot(`startup-race-${slug}`, cleanupTasks);
}

function writeCache(root: TestRoot, servers: Record<string, CacheServer>): void {
	mkdirSync(join(root.agentDir, "cache"), { recursive: true });
	writeFileSync(
		join(root.agentDir, "cache", "mcp-cache.json"),
		`${JSON.stringify({ version: 1, servers }, null, 2)}\n`,
	);
}

async function readCache(root: TestRoot): Promise<CacheFile> {
	return JSON.parse(await readFile(join(root.agentDir, "cache", "mcp-cache.json"), "utf8")) as CacheFile;
}

function cachedServer(root: TestRoot, name: string, toolNames: string[]): CacheServer {
	return {
		configHash: configHash(root, name),
		fetchedAt: Date.now(),
		instructions: "cached startup race instructions",
		prompts: [],
		resources: [],
		tools: toolNames.map((toolName) => ({
			name: toolName,
			description: `Cached ${toolName}`,
			inputSchema: { type: "object", properties: { value: { type: "string" } }, required: [] },
		})),
	};
}

function configHash(root: TestRoot, name: string): string {
	const config = loadMcpConfig({ agentDir: root.agentDir, cwd: root.cwd, projectTrusted: true });
	const hash = config.servers[name]?.configHash;
	if (hash === undefined) throw new Error(`missing config hash for ${name}`);
	return hash;
}

async function waitFor(assertion: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition timed out");
}

interface CacheFile {
	version: 1;
	servers: Record<string, CacheServer>;
}

interface CacheServer {
	configHash: string;
	fetchedAt: number;
	tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
	resources: unknown[];
	prompts: unknown[];
	instructions?: string;
}

function getErrorCause(error: Error): unknown {
	return Object.getOwnPropertyDescriptor(error, "cause")?.value;
}
