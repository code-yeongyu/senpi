import { afterEach, expect, it, vi } from "vitest";
import * as cache from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { SharedMcpLease } from "../../src/core/extensions/builtin/mcp/shared-lease.ts";
import { serverConfig } from "./fixtures/reconnect.ts";
import { cleanupRoots, makeRoot } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupRoots(cleanup);
});

// senpi#1921: a list_changed/owner-renew racing the first cache write cannot write twice.
it("claims one cache write per physical generation before awaiting filesystem IO", async () => {
	const root = makeRoot("shared-cache-race", cleanup);
	const fixture = await sharingHttpFixture();
	const registry = new HostMcpRegistry();
	const config = { ...serverConfig(), type: "http" as const, url: fixture.url, auth: false as const };
	const options = {
		config,
		agentDir: root.agentDir,
		configHash: "shared",
		serverName: "fx",
		logger: createMcpLogger("fx", { logDir: root.agentDir }),
	};
	const a = registry.attachShared("a", {}, options);
	const b = registry.attachShared("b", {}, options);
	if (!(a instanceof SharedMcpLease) || !(b instanceof SharedMcpLease)) throw new Error("missing shared leases");
	const started = Promise.withResolvers<void>();
	const duplicate = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const originalWrite = cache.writeMcpCachedServer;
	let writes = 0;
	vi.spyOn(cache, "writeMcpCachedServer").mockImplementation(async (...args) => {
		writes++;
		if (writes === 1) started.resolve();
		else duplicate.resolve();
		await release.promise;
		return originalWrite(...args);
	});
	const first = a.shared.catalog();
	let second: Promise<cache.McpCachedServerCatalog> | undefined;
	try {
		await started.promise;
		second = b.shared.catalog(true);
		await Promise.race([second, duplicate.promise]);
		expect(writes).toBe(1);
	} finally {
		release.resolve();
		await Promise.allSettled([first, second]);
		await registry.dispose();
		await fixture.close();
	}
	const persisted = await cache.readMcpCatalogCache(root.agentDir);
	expect(persisted.servers.fx.tools.map((tool) => tool.name)).toEqual(["echo"]);
	expect(fixture.connects).toBe(1);
});
