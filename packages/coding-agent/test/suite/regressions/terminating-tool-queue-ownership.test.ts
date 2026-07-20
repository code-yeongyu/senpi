import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

type QueueName = "steering" | "followUp";

function createDeferred(): { readonly promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((deferredResolve) => {
		resolve = deferredResolve;
	});
	return { promise, resolve: () => resolve?.() };
}

async function createBlockedTerminatingRun(): Promise<{
	readonly harness: Harness;
	readonly promptPromise: Promise<void>;
	readonly releaseTool: () => void;
	readonly preparationStarted: Promise<void>;
	readonly releasePreparation: () => void;
}> {
	const toolStarted = createDeferred();
	const toolRelease = createDeferred();
	const preparationStarted = createDeferred();
	const preparationRelease = createDeferred();
	const terminatingTool: AgentTool = {
		name: "terminate_after_wait",
		label: "Terminate after wait",
		description: "Wait, then terminate the current run",
		parameters: Type.Object({}),
		execute: async () => {
			toolStarted.resolve();
			await toolRelease.promise;
			return {
				content: [{ type: "text", text: "terminated" }],
				details: {},
				terminate: true,
			};
		},
	};
	const harness = await createHarness({
		tools: [terminatingTool],
		prepareNextTurnWithContext: async () => {
			preparationStarted.resolve();
			await preparationRelease.promise;
			return undefined;
		},
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("terminate_after_wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("replacement handled"),
	]);
	const promptPromise = harness.session.prompt("start");
	await toolStarted.promise;
	return {
		harness,
		promptPromise,
		releaseTool: toolRelease.resolve,
		preparationStarted: preparationStarted.promise,
		releasePreparation: preparationRelease.resolve,
	};
}

async function queueMessage(harness: Harness, queue: QueueName, text: string): Promise<void> {
	if (queue === "steering") {
		await harness.session.steer(text);
		return;
	}
	await harness.session.followUp(text);
}

describe("terminating-tool queue ownership", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([
		"steering",
		"followUp",
	] as const)("retains %s input without restarting provider work when public abort interrupts preparation", async (queue) => {
		// given
		const run = await createBlockedTerminatingRun();
		harnesses.push(run.harness);
		await queueMessage(run.harness, queue, "retain after abort");
		run.releaseTool();
		await run.preparationStarted;

		// when
		const abortPromise = run.harness.session.abort();
		run.releasePreparation();
		await Promise.all([run.promptPromise, abortPromise]);

		// then
		expect(run.harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(run.harness)).toEqual(["start"]);
		expect(run.harness.session.pendingMessageCount).toBe(1);
		expect(run.harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it.each([
		["steering", false],
		["steering", true],
		["followUp", false],
		["followUp", true],
	] as const)("does not deliver cleared %s input after successful preparation (replacement: %s)", async (queue, replace) => {
		// given
		const run = await createBlockedTerminatingRun();
		harnesses.push(run.harness);
		await queueMessage(run.harness, queue, "withdrawn safety instruction");
		run.releaseTool();
		await run.preparationStarted;

		// when
		const cleared = run.harness.session.clearQueue();
		if (replace) {
			await queueMessage(run.harness, queue, "replacement instruction");
		}
		run.releasePreparation();
		await run.promptPromise;

		// then
		expect(cleared).toEqual(
			queue === "steering"
				? { steering: ["withdrawn safety instruction"], followUp: [] }
				: { steering: [], followUp: ["withdrawn safety instruction"] },
		);
		expect(run.harness.faux.state.callCount).toBe(replace ? 2 : 1);
		expect(getUserTexts(run.harness)).toEqual(replace ? ["start", "replacement instruction"] : ["start"]);
		expect(run.harness.session.pendingMessageCount).toBe(0);
		expect(run.harness.session.agent.hasQueuedMessages()).toBe(false);
	});
});
