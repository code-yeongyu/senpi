import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { capturingPi } from "../../mcp/fixtures/register-call.ts";
import { cleanupRoots, makeRoot } from "../../mcp/fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "../../mcp/fixtures/sharing-http.ts";
import { createHarness, createTestUiContext, getToolResult } from "../harness.ts";

for (const exposure of ["direct", "search", "proxy"] as const) {
	for (const scenario of ["once", "deny", "approval-deny"] as const) {
		it(`checks real ${scenario} consent after selected readiness through ${exposure}`, async () => {
			const cleanup: Array<() => Promise<void>> = [];
			const root = makeRoot(`2843-consent-${exposure}-${scenario}`, cleanup);
			const fixture = await sharingHttpFixture();
			const seed = new McpService();
			const service = new McpService();
			const previousAgentDir = process.env[ENV_AGENT_DIR];
			let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
			let prompt: Promise<unknown> | undefined;
			const approvalEntered = Promise.withResolvers<void>();
			const approvalReply = Promise.withResolvers<string>();
			try {
				await writeFile(
					join(root.agentDir, "mcp.json"),
					JSON.stringify({
						settings: { stubSwap: true },
						mcpServers: {
							fx: {
								type: "http",
								url: fixture.url,
								auth: false,
								lifecycle: "lazy",
								exposure,
								requestTimeoutMs: 2000,
							},
						},
					}),
				);
				await seed.attachSession(
					{ type: "session_start", reason: "startup" },
					{ cwd: root.cwd, isProjectTrusted: () => true },
					capturingPi(),
					{ agentDir: root.agentDir },
				);
				expect(await seed.whenAttachSettled(5000)).toBe("settled");
				await seed.dispose("quit");
				await fixture.endStreams();
				const entered = fixture.holdLists();
				process.env[ENV_AGENT_DIR] = root.agentDir;
				let approvals = 0;
				harness = await createHarness({
					extensionFlagValues: new Map([["permission-preset", "ask"]]),
					extensionFactories: [permissionSystemExtension, createMcpExtension(service)],
				});
				await harness.session.bindExtensions({
					uiContext: createTestUiContext({
						select: async () => {
							approvals++;
							if (scenario === "approval-deny" && approvals === 2) {
								approvalEntered.resolve();
								return approvalReply.promise;
							}
							return "Allow once";
						},
					}),
				});
				await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
				const name = exposure === "proxy" ? "mcp_fx" : "mcp_fx_echo";
				const args: Parameters<typeof fauxToolCall>[1] =
					exposure === "proxy"
						? { op: "call", tool: "echo", args: JSON.stringify({ value: "payload" }) }
						: { value: "payload" };
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				prompt = harness.session.prompt("call the fixture").catch((error: unknown) => error);
				await observed(entered, "The real MCP wrapper did not enter selected readiness");
				if (scenario === "deny") harness.getExtensionRunner().setFlagValue("permission", `${name}=deny`);
				if (scenario === "approval-deny") {
					await fixture.changeTools("echo", {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					});
				}
				fixture.releaseLists();
				if (scenario === "approval-deny") {
					await observed(approvalEntered.promise, "Changed MCP schema did not require fresh approval");
					harness.getExtensionRunner().setFlagValue("permission", `${name}=deny`);
					approvalReply.resolve("Allow once");
				}
				expect(await observed(prompt, "MCP permission scenario did not settle")).toBeUndefined();
				expect(approvals).toBe(scenario === "approval-deny" ? 2 : 1);
				expect(fixture.calls).toBe(scenario === "once" ? 1 : 0);
				if (scenario !== "once") expect(getToolResult(harness, name)).toHaveProperty("details.error");
				else expect(getToolResult(harness, name)).not.toHaveProperty("details.error");
			} finally {
				fixture.releaseLists();
				approvalReply.resolve("Deny");
				await prompt;
				await seed.dispose("quit");
				await service.dispose("quit");
				harness?.cleanup();
				if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
				else process.env[ENV_AGENT_DIR] = previousAgentDir;
				await fixture.close();
				await cleanupRoots(cleanup);
			}
		});
	}
}

function observed<T>(event: Promise<T>, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const signal = AbortSignal.timeout(5000);
		const abort = () => reject(new Error(message));
		signal.addEventListener("abort", abort, { once: true });
		void event.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
