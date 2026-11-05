import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createPreparedToolHost } from "../../../src/core/execution/pipeline-prepared.ts";
import { authorizeToolDispatch } from "../../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { registerDispatchIdentity } from "../../../src/core/extensions/builtin/permission-system/dispatch-metadata.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext } from "../harness.ts";

// senpi#5795: under the prepared pipeline the tool executes a frozen copy of its arguments, so a Once approval
// recorded in the tool_call preflight must follow the call to that copy, and only while its content is unchanged.
async function run(pipeline: "legacy" | "prepared", mutateAfterPreflight: boolean) {
	const remoteWrite = vi.fn();
	const identity = { owner: {}, metadata: "offered-operation" };
	const parameters = Type.Object({ value: Type.String() });
	registerDispatchIdentity(parameters, () => ({ ...identity }));
	let prompts = 0;
	const harness = await createHarness({
		extensionFlagValues: new Map([["permission-preset", "ask"]]),
		extensionFactories: [
			permissionSystemExtension,
			(pi) => {
				if (mutateAfterPreflight) {
					pi.on("tool_call", (event) => {
						if (event.toolName === "mcp_fixture_write") (event.input as { value: string }).value = "changed";
					});
				}
				pi.registerTool({
					name: "mcp_fixture_write",
					label: "Fixture write",
					description: "Write through a dispatch-authorized operation",
					parameters,
					async execute(toolCallId, input, signal, _onUpdate, ctx) {
						const request = { toolCallId, toolName: "mcp_fixture_write", input, identity: { ...identity } };
						const current = await authorizeToolDispatch(ctx.sessionManager, request, ctx, signal);
						if (current()) remoteWrite(input.value);
						return { content: [{ type: "text", text: "written" }], details: {} };
					},
				});
			},
		],
	});
	try {
		if (pipeline === "prepared") harness.agent.toolHost = createPreparedToolHost(harness.agent);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async () => {
					prompts++;
					return "Allow once";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp_fixture_write", { value: "payload" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write");
		return { prompts, remoteWrite };
	} finally {
		harness.cleanup();
	}
}

describe.each(["legacy", "prepared"] as const)("%s pipeline", (pipeline) => {
	it("asks once for an unchanged call and executes it under that approval", async () => {
		const { prompts, remoteWrite } = await run(pipeline, false);
		expect(prompts).toBe(1);
		expect(remoteWrite).toHaveBeenCalledExactlyOnceWith("payload");
	});

	it("asks again when a later tool_call hook changed the input in place after the approval", async () => {
		const { prompts, remoteWrite } = await run(pipeline, true);
		expect(prompts).toBe(2);
		expect(remoteWrite).toHaveBeenCalledExactlyOnceWith("changed");
	});
});
