import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { registerDispatchAuthorizer } from "../../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { capturingPi } from "../../mcp/fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "../../mcp/fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "../../mcp/fixtures/sharing-http.ts";
import { createHarness, createTestUiContext, getToolResult } from "../harness.ts";

for (const registered of [false, true]) {
	it(`distinguishes never-loaded authority from a retired inline authorizer (${registered})`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const root = makeRoot("2843-inline-authority", cleanup);
		const service = new McpService();
		const seed = new McpService();
		const fixture = await sharingHttpFixture();
		const previous = process.env[ENV_AGENT_DIR];
		let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
		let retire: (() => void) | undefined;
		let loadedPaths: readonly string[] | undefined;
		try {
			setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, exposure: "direct" } });
			await seed.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				capturingPi(),
				{ agentDir: root.agentDir },
			);
			expect(await seed.whenAttachSettled(5000)).toBe("settled");
			await seed.dispose("quit");
			await fixture.endStreams();
			process.env[ENV_AGENT_DIR] = root.agentDir;
			harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							loadedPaths = ctx.loadedExtensionPaths;
							if (registered) {
								retire = registerDispatchAuthorizer(ctx.sessionManager, {
									policy: () => ({ action: "allow", fingerprint: "inline-authority" }),
									ask: async () => {},
								});
							}
						});
					},
					createMcpExtension(service),
				],
			});
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
			expect(await service.whenAttachSettled(5000)).toBe("settled");
			expect(loadedPaths?.some((path) => path.includes("permission-system"))).toBe(false);
			retire?.();
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("mcp_fx_echo", { value: "payload" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("call the fixture");

			const outcome = getToolResult(harness, "mcp_fx_echo");
			expect(fixture.calls).toBe(registered ? 0 : 1);
			if (registered) expect(outcome.details).toMatchObject({ error: { kind: "permission_denied" } });
			else expect(outcome.details).toMatchObject({ server: "fx", tool: "echo" });
		} finally {
			retire?.();
			await seed.dispose("quit");
			await service.dispose("quit");
			harness?.cleanup();
			await fixture.close();
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
			await cleanupRoots(cleanup);
		}
	});
}
