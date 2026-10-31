/**
 * senpi#3588: a queued input whose user message keeps several text blocks (an ask-user answer with
 * the user's words, senpi#2920) must leave every queue view the moment its message starts. The queue
 * records the blocks joined by a newline, so delivery has to match by the same rule; a different join
 * left the delivered input listed as queued for the rest of the session.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const FRAME = "[Answer to question q-1]\nThe user responded: (see [The user's comment for question q-1] below)";
const LABEL = "[The user's comment for question q-1]";
const BLOCKS = (words: string) => [FRAME, LABEL, words];

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface QueueView {
	steering: readonly string[];
	followUp: readonly string[];
	pending: number;
	queuedInputs: number;
}

async function startWaitingRun() {
	const release = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await release.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("after the queued input"),
		fauxAssistantMessage("after the follow-up"),
	]);
	const toolStarted = Promise.withResolvers<void>();
	const view = (): QueueView => ({
		steering: [...harness.session.getSteeringMessages()],
		followUp: [...harness.session.getFollowUpMessages()],
		pending: harness.session.pendingMessageCount,
		queuedInputs: harness.session.getQueuedInputs().length,
	});
	const atDelivery = new Map<string, QueueView>();
	const delivered: unknown[] = [];
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "wait") toolStarted.resolve();
		if (event.type === "message_end" && event.message.role === "user" && Array.isArray(event.message.content)) {
			const first = event.message.content[0];
			if (first?.type === "text" && first.text === FRAME) {
				delivered.push(event.message.content);
				const last = event.message.content.at(-1);
				atDelivery.set(last?.type === "text" ? last.text : "", view());
			}
		}
	});
	const run = harness.session.prompt("start");
	await toolStarted.promise;
	return { session: harness.session, run, release: () => release.resolve(), view, atDelivery, delivered };
}

const EMPTY: QueueView = { steering: [], followUp: [], pending: 0, queuedInputs: 0 };

describe("senpi#3588 multi-block queued input leaves the queue when it starts", () => {
	it("an extension steer (the async ask-user answer shape) is delivered with its blocks and dequeued", async () => {
		const { session, run, release, view, atDelivery, delivered } = await startWaitingRun();
		await session.sendUserMessage(
			BLOCKS("ship it").map((text) => ({ type: "text" as const, text })),
			{ deliverAs: "steer" },
		);
		expect(view().steering).toEqual([BLOCKS("ship it").join("\n")]);
		release();
		await run;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toEqual(BLOCKS("ship it").map((text) => ({ type: "text", text })));
		expect(atDelivery.get("ship it")).toEqual(EMPTY);
		expect(view()).toEqual(EMPTY);
	});

	it("an extension follow-up with several blocks is dequeued when it starts", async () => {
		const { session, run, release, view, atDelivery } = await startWaitingRun();
		await session.sendUserMessage(
			BLOCKS("later").map((text) => ({ type: "text" as const, text })),
			{ deliverAs: "followUp" },
		);
		expect(view().followUp).toEqual([BLOCKS("later").join("\n")]);
		release();
		await run;

		expect(atDelivery.get("later")).toEqual(EMPTY);
		expect(view()).toEqual(EMPTY);
	});

	it("an identified steer (clientMessageId) with several blocks is dequeued when it starts", async () => {
		const { session, run, release, view, atDelivery } = await startWaitingRun();
		await session.prompt(BLOCKS("identified").join("\n"), {
			streamingBehavior: "steer",
			textBlocks: BLOCKS("identified"),
			clientMessageId: "client-3588",
		});
		expect(view().steering).toEqual([BLOCKS("identified").join("\n")]);
		expect(view().queuedInputs).toBe(1);
		release();
		await run;

		expect(atDelivery.get("identified")).toEqual(EMPTY);
		expect(view()).toEqual(EMPTY);
	});

	it("a started prompt that a competing run displaced into the steer queue is dequeued when it starts", async () => {
		const release = Promise.withResolvers<void>();
		const competingEntered = Promise.withResolvers<void>();
		let competing: Promise<void> | undefined;
		const harness: Harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						competing ??= harness.agent.prompt({ role: "user", content: "competing", timestamp: Date.now() });
						await competingEntered.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("competing answered"), fauxAssistantMessage("displaced answered")]);
		const stream = harness.agent.streamFunction;
		harness.agent.streamFunction = async (model, context, options) => {
			competingEntered.resolve();
			await release.promise;
			return stream(model, context, options);
		};
		const steeringAtDelivery: string[][] = [];
		const displacedQueued = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length > 0) displacedQueued.resolve();
			if (event.type === "message_end" && event.message.role === "user" && Array.isArray(event.message.content)) {
				if (event.message.content[0]?.type === "text" && event.message.content[0].text === FRAME)
					steeringAtDelivery.push([...harness.session.getSteeringMessages()]);
			}
		});

		const displaced = harness.session.prompt(BLOCKS("displaced").join("\n"), { textBlocks: BLOCKS("displaced") });
		await displacedQueued.promise;
		expect(harness.session.getSteeringMessages()).toEqual([BLOCKS("displaced").join("\n")]);
		release.resolve();
		await displaced;
		await competing;
		await harness.session.waitForSettledSessionWork();

		expect(steeringAtDelivery).toEqual([[]]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});
