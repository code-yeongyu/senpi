import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/extensions/builtin/mcp/config.ts";
import { getMcpService, McpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	awaitMcpToolRegistration,
	capturingPi,
	registeredTool,
	testContext,
	textContent,
	withoutMcpUtilityTools,
} from "./fixtures/register-call.ts";
import {
	cleanupRoots,
	makeRoot,
	readCounter,
	setConfig,
	stdioServer,
	type TestRoot,
	waitForCondition,
} from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("MCP disk metadata cache", () => {
	it("registers valid warm-cache tools at startup with zero fixture spawn, then lazy-connects on first call", async () => {
		const root = makeCacheRoot("warm");
		const counterFile = join(root.agentDir, "warm-spawns.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
		writeCache(root, { fx: cachedServer(root, "fx") });
		const pi = capturingPi();

		await attach(root, pi);

		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_tool_1"]);
		await expect(readCounter(counterFile)).rejects.toMatchObject({ code: "ENOENT" });

		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const result = await tool.execute("tc-cache", { value: "warm" }, undefined, undefined, testContext());

		expect(textContent(result)).toBe("fixture tool_1 value=warm mode=alpha");
		expect(await readCounter(counterFile)).toBe(1);
	});

	it("does not trust expired cache entries and rewrites them from a fresh fixture catalog", async () => {
		const root = makeCacheRoot("ttl");
		const counterFile = join(root.agentDir, "ttl-spawns.txt");
		setConfig(root, { fx: stdioServer(["--tools", "2", "--spawn-counter-file", counterFile]) });
		writeCache(root, { fx: cachedServer(root, "fx", { fetchedAt: Date.now() - 8 * DAY_MS, toolNames: ["fake"] }) });
		const pi = capturingPi();

		await attach(root, pi);
		await awaitMcpToolRegistration("fx");
		await awaitCacheTools(root, 2);

		expect(dedupedRegisteredTools(pi)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(await readCounter(counterFile)).toBe(1);
		const cache = await readCache(root);
		expect(cache.servers.fx.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2"]);
	});

	it("ignores corrupted cache JSON and rebuilds it without crashing", async () => {
		const root = makeCacheRoot("corrupt");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		mkdirSync(join(root.agentDir, "cache"), { recursive: true });
		writeFileSync(cachePath(root), "{not json");
		const pi = capturingPi();

		await attach(root, pi);
		await awaitMcpToolRegistration("fx");
		await awaitCacheTools(root, 1);

		expect(dedupedRegisteredTools(pi)).toEqual(["mcp_fx_tool_1"]);
		const cache = await readCache(root);
		expect(cache.servers.fx.tools.map((tool) => tool.name)).toEqual(["tool_1"]);
	});

	it("invalidates config-hash mismatches instead of registering poisoned fake tools", async () => {
		const root = makeCacheRoot("hash");
		const counterFile = join(root.agentDir, "hash-spawns.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
		writeCache(root, { fx: cachedServer(root, "fx", { configHash: "poisoned", toolNames: ["fake_999"] }) });
		const pi = capturingPi();

		await attach(root, pi);
		await awaitMcpToolRegistration("fx");
		await awaitCacheTools(root, 1);

		expect(dedupedRegisteredTools(pi)).toEqual(["mcp_fx_tool_1"]);
		expect(withoutMcpUtilityTools(pi.registeredTools)).not.toContain("mcp_fx_fake_999");
		expect(await readCounter(counterFile)).toBe(1);
		const cache = await readCache(root);
		expect(cache.servers.fx.configHash).toBe(configHash(root, "fx"));
		expect(cache.servers.fx.tools.map((tool) => tool.name)).toEqual(["tool_1"]);
	});

	it("refreshes eager servers from the live catalog when a valid warm cache differs", async () => {
		const root = makeCacheRoot("eager-mismatch");
		const counterFile = join(root.agentDir, "eager-spawns.txt");
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "2", "--spawn-counter-file", counterFile]), lifecycle: "eager" },
		});
		writeCache(root, { fx: cachedServer(root, "fx", { toolNames: ["stale_cached"] }) });
		const pi = capturingPi();

		await attach(root, pi);

		await waitForCondition(() => withoutMcpUtilityTools(pi.activeTools).includes("mcp_fx_tool_2"), 10_000);
		expect(await readCounter(counterFile)).toBe(1);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);
		expect(withoutMcpUtilityTools(pi.activeTools)).not.toContain("mcp_fx_stale_cached");
		const cache = await readCache(root);
		expect(cache.servers.fx.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2"]);
	});

	it("keeps concurrent cache writers from leaving torn JSON", async () => {
		const root = makeCacheRoot("concurrent");
		setConfig(root, { fx: stdioServer(["--tools", "3"]) });
		const first = new McpService();
		const second = new McpService();
		try {
			await Promise.all([
				first.attachSession({ type: "session_start", reason: "startup" }, contextFor(root), capturingPi(), {
					agentDir: root.agentDir,
				}),
				second.attachSession({ type: "session_start", reason: "startup" }, contextFor(root), capturingPi(), {
					agentDir: root.agentDir,
				}),
			]);
			// Both attaches are race-bounded; the cache refresh completes in the
			// background continuation, so await the torn-write window closing.
			await waitForCondition(async () => {
				try {
					return (await readCache(root)).servers.fx.tools.length === 3;
				} catch {
					return false;
				}
			}, 10_000);
			const cache = await readCache(root);
			expect(cache.servers.fx.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2", "tool_3"]);
		} finally {
			await Promise.all([first.dispose("quit"), second.dispose("quit")]);
		}
	});
});

function makeCacheRoot(slug: string): TestRoot {
	return makeRoot(`catalog-cache-${slug}`, cleanupTasks);
}

function contextFor(root: TestRoot) {
	return { cwd: root.cwd, isProjectTrusted: () => true };
}

function cachePath(root: TestRoot): string {
	return join(root.agentDir, "cache", "mcp-cache.json");
}

function writeCache(root: TestRoot, servers: Record<string, CacheServer>): void {
	mkdirSync(join(root.agentDir, "cache"), { recursive: true });
	writeFileSync(cachePath(root), `${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
}

/** The raced attach can register the same catalog twice: the continuation
 * scheduled at the race deadline and attach's own registration pass when the
 * connect lands between the two. Production registerTool replaces by name, so
 * assert the deduped set (same invariant as the exposure-policy suite). */
function dedupedRegisteredTools(pi: ReturnType<typeof capturingPi>): string[] {
	return [...new Set(withoutMcpUtilityTools(pi.registeredTools))];
}

/** The raced background continuation writes the disk cache after the in-memory
 * catalog is set; await the file landing before asserting its contents. */
async function awaitCacheTools(root: TestRoot, count: number): Promise<void> {
	await waitForCondition(async () => {
		try {
			return (await readCache(root)).servers.fx.tools.length === count;
		} catch {
			return false;
		}
	}, 10_000);
}

async function readCache(root: TestRoot): Promise<CacheFile> {
	return JSON.parse(await readFile(cachePath(root), "utf8")) as CacheFile;
}

function cachedServer(
	root: TestRoot,
	name: string,
	options: { configHash?: string; fetchedAt?: number; toolNames?: string[] } = {},
): CacheServer {
	return {
		configHash: options.configHash ?? configHash(root, name),
		fetchedAt: options.fetchedAt ?? Date.now(),
		instructions: "cached fixture instructions",
		prompts: [],
		resources: [],
		tools: (options.toolNames ?? ["tool_1"]).map((toolName) => ({
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
