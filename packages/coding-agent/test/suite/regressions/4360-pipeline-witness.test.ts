import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness } from "../harness.ts";

// senpi#4360: real AgentSession wiring, not a standalone receipt writer fixture.
it("records the selected execution pipeline outside messages and keeps an opaque scope stable", async () => {
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "witness_probe",
					label: "probe",
					description: "fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const call = fauxToolCall("witness_probe", {});
		harness.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		const scope = harness.agent.getExecutionScope?.();
		expect(scope?.id).not.toBe(harness.sessionManager.getSessionId());
		expect(scope?.root).toBe(harness.tempDir);
		await harness.session.prompt("run");
		expect(harness.agent.getExecutionScope?.()).toEqual(scope);
		const witnesses = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "execution-pipeline");
		expect(witnesses).toHaveLength(1);
		expect(witnesses[0]).toMatchObject({ data: { pipeline: "legacy", toolCallId: call.id } });
		expect(harness.session.messages.some((message) => "pipeline" in message)).toBe(false);
		expect(harness.events.some((event) => "pipeline" in event)).toBe(false);
	} finally {
		harness.cleanup();
	}
});
