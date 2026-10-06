import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	getMcpCatalogCachePath,
	readMcpCatalogCache,
	writeMcpCachedServer,
} from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { cleanupRoots, makeRoot } from "./fixtures/service-lifecycle.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, readFile: vi.fn(original.readFile), rename: vi.fn(original.rename) };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupRoots(cleanup);
});

it("preserves both server catalogs when their updates arrive before the first commit", async () => {
	const root = makeRoot("cache-merge", cleanup);
	const path = getMcpCatalogCachePath(root.agentDir);
	const baseline = '{"version":1,"servers":{}}';
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, baseline, "utf8");
	const originalRead = vi.mocked(readFile).getMockImplementation();
	const originalRename = vi.mocked(rename).getMockImplementation();
	if (originalRead === undefined || originalRename === undefined) throw new Error("missing filesystem implementation");
	let committed = false;
	vi.mocked(readFile).mockImplementation((...args) => {
		// A read observes the committed file when it starts, not a later rename.
		// This models two updates entering before the first asynchronous commit.
		if (args[0] === path && !committed) return Promise.resolve(baseline);
		return originalRead(...args);
	});
	vi.mocked(rename).mockImplementation(async (...args) => {
		await originalRename(...args);
		if (args[1] === path) committed = true;
	});
	const catalog = {
		configHash: "fixture",
		fetchedAt: 1,
		prompts: [],
		resources: [],
		tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
	};
	await Promise.all([
		writeMcpCachedServer(root.agentDir, "first", catalog),
		writeMcpCachedServer(root.agentDir, "second", catalog),
	]);
	const persisted = await readMcpCatalogCache(root.agentDir);
	expect(Object.keys(persisted.servers).sort()).toEqual(["first", "second"]);
	expect(persisted.servers.first?.tools[0]?.name).toBe("echo");
	expect(persisted.servers.second?.tools[0]?.name).toBe("echo");
});
