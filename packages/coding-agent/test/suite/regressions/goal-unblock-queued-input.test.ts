import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal, updateGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { createHarness } from "../harness.ts";

// A queued prompt returns before before_agent_start fires, so it must still unblock.
describe("goal resumes on a prompt queued during streaming", () => {
	it("reactivates a blocked goal from a followUp prompt queued mid-turn", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({
			persistSession: true,
			tools: [waitTool],
			extensionFactories: [goalExtension],
		});
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);

		await createGoal(ref, "Wait for the external job to finish");
		await updateGoal(ref, { status: "blocked", reason: "continuation cap reached" }, "model");
		expect((await readGoal(ref))?.status).toBe("blocked");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished the current turn"),
			fauxAssistantMessage("resumed the goal as instructed"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start the work");
		await sawToolStart;
		await harness.session.prompt("actually, resume the goal", { streamingBehavior: "followUp" });

		releaseToolExecution?.();
		await promptPromise;

		expect((await readGoal(ref))?.status).toBe("active");
	});
});
