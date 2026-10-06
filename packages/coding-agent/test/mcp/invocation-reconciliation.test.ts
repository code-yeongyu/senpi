import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

function nextRegistration(service: McpService, matches: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const signal = AbortSignal.timeout(5000);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!matches()) return;
			finish();
			resolve();
		});
		const abort = () => {
			finish();
			reject(new Error("MCP registration event did not settle"));
		};
		function finish() {
			unsubscribe();
			signal.removeEventListener("abort", abort);
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

for (const exposure of ["direct", "search", "proxy"] as const) {
	it(`refuses a removed tool through a retained ${exposure} wrapper without dispatch`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const service = new McpService();
		const fixture = await sharingHttpFixture();
		try {
			const root = makeRoot(`2843-removed-${exposure}`, cleanup);
			await writeFile(
				join(root.agentDir, "mcp.json"),
				JSON.stringify({
					settings: { stubSwap: true },
					mcpServers: {
						fx: { type: "http", url: fixture.url, auth: false, exposure, requestTimeoutMs: 2000 },
					},
				}),
			);
			const pi = capturingPi();
			const name = exposure === "proxy" ? "mcp_fx" : "mcp_fx_echo";
			const initial = nextRegistration(service, () => pi.toolDefinitions.has(name));
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir },
			);
			await initial;
			expect(await service.whenAttachSettled(5000)).toBe("settled");
			const retained = registeredTool(pi, name);
			const updated = nextRegistration(service, () =>
				exposure === "proxy"
					? pi.toolDefinitions.get(name) !== retained
					: pi.toolDefinitions.has("mcp_fx_replacement"),
			);
			await fixture.changeTools("replacement");
			await updated;
			const input = exposure === "proxy" ? { op: "call", tool: "echo", args: "{}" } : {};
			// These are public SDK definitions called without an engine-owned context.
			// Permission/cancellation proofs use the real hook contexts in permission/live-dispatch.test.ts.
			const result = await Reflect.apply(retained.execute, retained, ["retained", input, undefined, undefined]);
			expect(fixture.calls).toBe(0);
			expect(result).toMatchObject({ details: { error: { kind: "unavailable", tool: "echo", server: "fx" } } });
		} finally {
			await service.dispose("test");
			await fixture.close();
			await cleanupRoots(cleanup);
		}
	});
}
