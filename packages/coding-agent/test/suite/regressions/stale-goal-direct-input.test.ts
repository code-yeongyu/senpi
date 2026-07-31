/** Locks stale-goal admission: accepted direct input disarms continuation without pausing the Goal. */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

const STABLE_OUTPUT = "unchanged observable goal output";

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function createHarnessWithDeliveredContinuation(
	options: { handleRejected?: boolean; rejectSignal?: AbortController } = {},
): Promise<{
	harness: Harness;
	goalId: string;
}> {
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			goalExtension,
			...(options.handleRejected || options.rejectSignal
				? [
						(pi: ExtensionAPI) => {
							pi.on("input", (event) => {
								if (event.text !== "rejected prompt") return undefined;
								options.rejectSignal?.abort();
								return options.handleRejected ? { action: "handled" as const } : undefined;
							});
						},
					]
				: []),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});

	const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
	const goal = await createGoal(ref, "Complete the active goal without drifting to unrelated work");
	harness.setResponses([fauxAssistantMessage(STABLE_OUTPUT), fauxAssistantMessage(STABLE_OUTPUT)]);

	// Drive a real extension-originated turn. Its clean agent_end queues the hidden
	// continuation, records the signature, and the matching continuation response then
	// stops as stale instead of recursively queueing another turn.
	await harness.session.prompt("begin tracked work", { source: "extension" });

	const persisted = await readGoal(ref);
	expect(persisted).toMatchObject({ id: goal.id, status: "active", consecutiveContinuations: 1 });
	expect(persisted?.lastContinuationSignature).toEqual(expect.any(String));
	expect(
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE),
	).toHaveLength(1);
	return { harness, goalId: goal.id };
}

describe("stale goal direct input", () => {
	it("leaves even a matching-signature Goal active after accepted direct input", async () => {
		const { harness, goalId } = await createHarnessWithDeliveredContinuation();
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		harness.setResponses([fauxAssistantMessage("answered the newer request")]);

		await harness.session.prompt("switch to this newer request");

		expect(await readGoal(ref)).toMatchObject({ id: goalId, status: "active", consecutiveContinuations: 0 });
	});

	it("does not pause when observable state changed after the continuation was delivered", async () => {
		const { harness, goalId } = await createHarnessWithDeliveredContinuation();
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		harness.sessionManager.appendMessage(fauxAssistantMessage("new observable progress after delivery"));
		harness.setResponses([
			fauxAssistantMessage("new observable progress after delivery"),
			fauxAssistantMessage("new observable progress after delivery"),
		]);

		await harness.session.prompt("continue with the changed state");

		expect(await readGoal(ref)).toMatchObject({ id: goalId, status: "active" });
	});

	it("does not pause a fresh active goal that has never received a continuation", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		const goal = await createGoal(ref, "Fresh goal with no delivered continuation");
		expect(goal.lastContinuationSignature).toBeUndefined();
		harness.setResponses([fauxAssistantMessage(STABLE_OUTPUT), fauxAssistantMessage(STABLE_OUTPUT)]);

		await harness.session.prompt("work on the fresh goal");

		expect(await readGoal(ref)).toMatchObject({ id: goal.id, status: "active" });
	});

	it("keeps the Goal unchanged when another input extension handles the prompt", async () => {
		const { harness, goalId } = await createHarnessWithDeliveredContinuation({ handleRejected: true });
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);

		await harness.session.prompt("rejected prompt");

		expect(await readGoal(ref)).toMatchObject({ id: goalId, status: "active" });
	});

	it("keeps the Goal unchanged when admission rejects the prompt", async () => {
		const controller = new AbortController();
		const { harness, goalId } = await createHarnessWithDeliveredContinuation({ rejectSignal: controller });
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);

		await expect(harness.session.prompt("rejected prompt", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(await readGoal(ref)).toMatchObject({ id: goalId, status: "active" });
	});
});
