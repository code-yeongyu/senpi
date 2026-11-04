import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";

// senpi#5412 (S21a), senpi#5728 (S36): a real AgentSession runs its tool calls on the prepared pipeline, its only one.
// An explicit sink sees which pipeline ran; no default writer persists a receipt (the EQ sink lands with S18b part 3).
afterEach(() => {
	vi.unstubAllEnvs();
});

async function run(flag: string | undefined) {
	if (flag !== undefined) vi.stubEnv("SENPI_EXECUTION_PIPELINE", flag);
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
		const witnesses: unknown[] = [];
		harness.agent.onExecutionPipeline = (witness) => {
			witnesses.push(witness);
		};
		await harness.session.bindExtensions({});
		const call = fauxToolCall("witness_probe", {});
		harness.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("run");

		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ toolCallId: call.id, isError: false });
		return { witnesses, callId: call.id, persisted: readFileSync(sessionFile, "utf8") };
	} finally {
		harness.cleanup();
	}
}

it.each([undefined, "", "default", "prepared"])(
	"SENPI_EXECUTION_PIPELINE=%j runs the prepared pipeline and persists no receipt",
	async (flag) => {
		const { witnesses, callId, persisted } = await run(flag);
		expect(witnesses).toEqual([{ pipeline: "prepared", toolCallId: callId }]);
		expect(persisted).not.toContain('"execution-pipeline"');
	},
);

it("refuses the removed legacy scheduler instead of running the default under its name", async () => {
	await expect(run("legacy")).rejects.toThrow('SENPI_EXECUTION_PIPELINE must be prepared or default, got "legacy"');
});
