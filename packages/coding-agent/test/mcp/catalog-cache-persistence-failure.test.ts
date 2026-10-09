import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

for (const shared of [false, true]) {
	it(`keeps live tools callable after cache persistence fails (${shared ? "shared" : "private"})`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const registry = new HostMcpRegistry();
		const service = new McpService(shared ? { mcpRegistry: registry } : {});
		const fixture = await sharingHttpFixture();
		try {
			const root = makeRoot("2843-cache-write-failure", cleanup);
			setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, exposure: "direct" } });
			// A file at the cache directory blocks real persistence on every platform, even as root.
			await writeFile(join(root.agentDir, "cache"), "blocked cache directory");
			const pi = capturingPi();
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir },
			);
			expect(await service.whenAttachSettled(5000)).toBe("settled");
			const tool = registeredTool(pi, "mcp_fx_echo");
			for (const value of ["first", "later"]) {
				const result: Awaited<ReturnType<typeof tool.execute>> = await Reflect.apply(tool.execute, tool, [
					`cache-${value}`,
					{ value },
					undefined,
					undefined,
				]);
				expect(result).not.toHaveProperty("details.error");
				expect(result.content).toContainEqual({ type: "text", text: JSON.stringify({ value }) });
			}
			expect(fixture.calls).toBe(2);
			expect(fixture.connects).toBe(1);
		} finally {
			await service.dispose("quit");
			await registry.dispose();
			await fixture.close();
			await cleanupRoots(cleanup);
		}
	});
}
