import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness } from "../harness.ts";

// senpi#4360: real AgentSession wiring, not a standalone receipt writer fixture.
it.each([false, true])("only records pipeline receipts with an explicit sink (configured: %s)", async (configured) => {
	const harness = await createHarness({
		persistSession: true,
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
		const sink = configured
			? (witness: Parameters<NonNullable<typeof harness.agent.onExecutionPipeline>>[0]) => {
					harness.sessionManager.appendCustomEntry("execution-pipeline", witness);
				}
			: undefined;
		if (configured) harness.agent.onExecutionPipeline = sink;
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
		expect(witnesses).toHaveLength(configured ? 1 : 0);
		expect(harness.agent.onExecutionPipeline).toBe(sink);
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const persisted = readFileSync(sessionFile, "utf8");
		if (configured) {
			expect(witnesses[0]).toMatchObject({ data: { pipeline: "legacy", toolCallId: call.id } });
			expect(persisted).toContain('"execution-pipeline"');
		} else {
			expect(persisted).not.toContain('"execution-pipeline"');
			const entries = harness.sessionManager.getBranch();
			const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(assistant).toBeDefined();
			expect(result).toBeDefined();
			expect(result?.parentId).toBe(assistant?.id);
		}
		expect(harness.session.messages.some((message) => "pipeline" in message)).toBe(false);
		expect(harness.events.some((event) => "pipeline" in event)).toBe(false);
	} finally {
		harness.cleanup();
	}
});
