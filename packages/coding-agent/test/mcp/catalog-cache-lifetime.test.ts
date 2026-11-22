import lockfile from "proper-lockfile";
import { expect, it, vi } from "vitest";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { cleanupRoots, makeRoot } from "./fixtures/service-lifecycle.ts";

it("does not persist a catalog whose owner was retired while the cache lock was pending", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const root = makeRoot("2843-cache-owner", cleanup);
	const catalog = {
		configHash: "fixture",
		fetchedAt: 1,
		prompts: [],
		resources: [],
		tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
	};
	await writeMcpCachedServer(root.agentDir, "preserved", catalog);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const originalLock = lockfile.lock;
	const mockedLock = vi.spyOn(lockfile, "lock").mockImplementation(async (...args) => {
		const unlock = await originalLock(...args);
		entered.resolve();
		await release.promise;
		return unlock;
	});
	let current = true;
	const write: Promise<void> = Reflect.apply(writeMcpCachedServer, undefined, [
		root.agentDir,
		"retired",
		catalog,
		() => current,
	]);
	try {
		await entered.promise;
		current = false;
		release.resolve();
		await write;
		const persisted = await readMcpCatalogCache(root.agentDir);
		expect(persisted.servers.preserved?.tools[0]?.name).toBe("echo");
		expect(persisted.servers).not.toHaveProperty("retired");
	} finally {
		release.resolve();
		await write;
		mockedLock.mockRestore();
		await cleanupRoots(cleanup);
	}
});
