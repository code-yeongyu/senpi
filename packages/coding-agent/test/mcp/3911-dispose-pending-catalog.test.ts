import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { expect, it, vi } from "vitest";
import { getMcpCatalogCachePath } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

it.each(["normal drain", "expired deadline"])("retires a pending catalog write on %s (#3911)", async (scenario) => {
	resetMcpServiceForTests();
	const cleanup: Array<() => Promise<void>> = [];
	const root = makeRoot("3911-dispose", cleanup);
	const server = await sharingHttpFixture();
	const service = getMcpService();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = lockfile.lock;
	const lock = vi.spyOn(lockfile, "lock").mockImplementation(async (...args) => {
		const unlock = await original(...args);
		if (args[1]?.lockfilePath === `${getMcpCatalogCachePath(root.agentDir)}.lock`) {
			entered.resolve();
			await release.promise;
		}
		return unlock;
	});
	let shutdown: Promise<void> | undefined;
	try {
		if (scenario === "expired deadline") vi.stubEnv("SENPI_MCP_DEFERRED_DISPOSE_TIMEOUT_MS", "0");
		setConfig(root, { fx: { type: "http", url: server.url, auth: false, lifecycle: "lazy" } });
		await attach(service, root, "startup");
		await entered.promise;
		shutdown = service.dispose("quit");
		expect(await service.whenAttachSettled(0)).toBe("timeout");
		if (scenario === "expired deadline") {
			await shutdown;
			await rm(root.agentDir, { recursive: true });
		}
		release.resolve();
		await shutdown;
		expect(await service.whenAttachSettled(5000)).toBe("settled");
		if (scenario === "expired deadline") expect(existsSync(root.agentDir)).toBe(false);
	} finally {
		release.resolve();
		await (shutdown ?? service.dispose("quit"));
		lock.mockRestore();
		vi.unstubAllEnvs();
		await server.close();
		await cleanupRoots(cleanup);
		resetMcpServiceForTests();
	}
});
