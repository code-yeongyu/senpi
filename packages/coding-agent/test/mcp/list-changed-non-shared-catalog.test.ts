import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpCatalogCache } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { capturingPi, registeredTool, testContext, withoutMcpUtilityTools } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

// Regression for code-yeongyu/senpi#2188: list_changed on a non-shared connection registers the new listing.

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("MCP list_changed on a non-shared connection (#2188)", () => {
	it("registers the changed listing, keeps the removed tool tombstoned, and persists the catalog", async () => {
		const root = makeRoot("list-changed-non-shared", cleanupTasks);
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager" } });
		const pi = capturingPi();
		const service = getMcpService();

		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual(["mcp_fx_echo"]);

		const refreshed = new Promise<void>((resolve) => {
			const unsubscribe = service.onMcpRegistrationChanged(() => {
				unsubscribe();
				resolve();
			});
		});
		await fixture.changeTools("after_change");
		await refreshed;

		expect(withoutMcpUtilityTools(pi.registeredTools)).toContain("mcp_fx_after_change");
		expect(pi.activeTools).not.toContain("mcp_fx_echo");
		await expect(
			registeredTool(pi, "mcp_fx_echo").execute(
				"call-1",
				{},
				undefined,
				undefined,
				testContext() as ExtensionToolContext,
			),
		).rejects.toThrow(/no longer available on fx/);
		const cache = await readMcpCatalogCache(root.agentDir);
		expect(cache.servers.fx?.tools.map((tool) => tool.name)).toEqual(["after_change"]);
	}, 30_000);
});
