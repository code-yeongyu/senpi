import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import {
	createGoal,
	readGoal,
	recordContinuationDelivered,
	updateGoal,
} from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE } from "../../../src/core/manual-continue.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function makeSession(tools?: AgentTool[]) {
	const snapshots: Goal[] = [];
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			goalExtension,
			(pi) => {
				pi.on("tool_call", async (event, ctx) => {
					if (event.toolName !== "get_goal") return;
					const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
					if (goal) snapshots.push(goal);
				});
			},
		],
		tools,
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	harness.setResponses([fauxAssistantMessage("ready")]);
	await harness.session.prompt("Start the task");
	return { harness, ref: goalStoreRef(harness.sessionManager, harness.tempDir), snapshots };
}

function finishGoal(harness: Harness): void {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
}

function observedGoal(harness: Harness) {
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "get_goal",
	);
	expect(result).toBeDefined();
	return JSON.parse(getMessageText(result)).goal;
}

// #1871: manual continue bypasses ordinary input admission, so it needs its own resume signal.
describe("blocked goal resume through the manual-continue shortcut", () => {
	it.each([
		"Waiting on a user decision",
		"user interrupted the turn",
		"provider error ended the turn (retries exhausted)",
	])("resumes a blocked goal before its next tool call: %s", async (reason) => {
		const { harness, ref, snapshots } = await makeSession();
		const original = await createGoal(ref, "Finish the task");
		await updateGoal(ref, { status: "blocked", reason });
		await recordContinuationDelivered(ref, "previous-attempt");
		finishGoal(harness);

		await harness.session.prompt(" . ");

		expect(observedGoal(harness)).toMatchObject({
			objective: original.objective,
			status: "active",
		});
		expect(snapshots[0]).toMatchObject({
			id: original.id,
			status: "active",
			consecutiveContinuations: 0,
			unattendedContinuations: 0,
		});
		expect(snapshots[0]).not.toHaveProperty("blockedReason");
		expect(snapshots[0]).not.toHaveProperty("blockedAt");
		expect(snapshots[0]).not.toHaveProperty("lastContinuationSignature");
		expect(getUserTexts(harness)).toEqual(["Start the task"]);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([
			expect.objectContaining({ customType: MANUAL_CONTINUE_CUSTOM_TYPE, display: false }),
		]);
		expect((await readGoal(ref))?.status).toBe("complete");
	});

	it.each(["steer", "followUp"] as const)("resumes on delivered %s dot", async (delivery) => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to release execution",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const { harness, ref } = await makeSession([waitTool]);
		await createGoal(ref, "Finish the task");
		await updateGoal(ref, { status: "blocked", reason: "Waiting on a user decision" });
		const remainingResponses = [
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...(delivery === "followUp" ? [fauxAssistantMessage("current turn finished")] : []),
			fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		harness.setResponses(remainingResponses);

		const running = harness.session.prompt("Wait for my next instruction");
		try {
			await started.promise;
			await harness.session.prompt(".", { streamingBehavior: delivery });
			expect((await readGoal(ref))?.status).toBe("blocked");
		} finally {
			release.resolve();
		}
		await running;

		expect(observedGoal(harness)?.status).toBe("active");
		expect(getUserTexts(harness)).toEqual(["Start the task", "Wait for my next instruction"]);
	});

	it.each(["paused", "complete"] as const)("does not reactivate a %s goal", async (status) => {
		const { harness, ref } = await makeSession();
		await createGoal(ref, "Finish the task");
		await updateGoal(ref, { status }, status === "paused" ? "user" : "model");
		const stopped = await readGoal(ref);
		harness.setResponses([fauxAssistantMessage("continued conversation")]);

		await harness.session.prompt(".");

		expect(await readGoal(ref)).toEqual(stopped);
	});

	it.each(["ordinary", "image", "custom"] as const)("keeps intentional blocks for %s input", async (kind) => {
		const { harness, ref } = await makeSession();
		await createGoal(ref, "Finish the task");
		await updateGoal(ref, { status: "blocked", reason: "Waiting on a user decision" });
		const blocked = await readGoal(ref);
		harness.setResponses([fauxAssistantMessage("reply")]);

		switch (kind) {
			case "ordinary":
				await harness.session.prompt("Tell me the status");
				break;
			case "image":
				await harness.session.prompt(".", {
					images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
				});
				break;
			case "custom":
				await harness.session.sendCustomMessage(
					{ customType: "unrelated-notice", content: "A notification", display: false },
					{ triggerTurn: true },
				);
				break;
		}

		expect(await readGoal(ref)).toEqual(blocked);
	});

	it("continues without creating a goal when none exists", async () => {
		const { harness, ref } = await makeSession();
		harness.setResponses([fauxAssistantMessage("continued conversation")]);

		await harness.session.prompt(".");

		expect(await readGoal(ref)).toBeNull();
		expect(getUserTexts(harness)).toEqual(["Start the task"]);
	});
});
