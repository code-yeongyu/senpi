import { expect, it } from "vitest";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

// #2843: age schedules refresh; identity, not age, decides metadata eligibility.
it("advertises an aged matching catalog while its background refresh is held", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const seed = new McpService();
	const service = new McpService();
	try {
		const root = makeRoot("2843-aged-catalog", cleanup);
		setConfig(root, {
			fx: {
				type: "http",
				url: fixture.url,
				auth: false,
				lifecycle: "lazy",
				exposure: "direct",
				requestTimeoutMs: 2000,
			},
		});
		const context = { cwd: root.cwd, isProjectTrusted: () => true };
		await seed.attachSession({ type: "session_start", reason: "startup" }, context, capturingPi(), {
			agentDir: root.agentDir,
		});
		expect(await seed.whenAttachSettled(5000)).toBe("settled");
		await seed.dispose("quit");
		const cached = (await readMcpCatalogCache(root.agentDir)).servers.fx;
		if (cached === undefined) throw new Error("missing seeded catalog");
		await writeMcpCachedServer(root.agentDir, "fx", {
			...cached,
			fetchedAt: cached.fetchedAt - 8 * 24 * 60 * 60 * 1000,
		});
		fixture.holdLists();
		fixture.setTools("fresh");
		const pi = capturingPi();
		await service.attachSession({ type: "session_start", reason: "startup" }, context, pi, {
			agentDir: root.agentDir,
		});
		expect(pi.activeTools).toContain("mcp_fx_echo");
		fixture.releaseLists();
		expect(await service.whenAttachSettled(5000)).toBe("settled");
		const fresh = registeredTool(pi, "mcp_fx_fresh");
		const result: Awaited<ReturnType<typeof fresh.execute>> = await Reflect.apply(fresh.execute, fresh, [
			"fresh-call",
			{ value: "refreshed" },
			undefined,
			undefined,
		]);
		expect(result.content).toContainEqual({ type: "text", text: JSON.stringify({ value: "refreshed" }) });
	} finally {
		fixture.releaseLists();
		await service.whenAttachSettled(5000);
		await seed.dispose("quit");
		await service.dispose("quit");
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});
