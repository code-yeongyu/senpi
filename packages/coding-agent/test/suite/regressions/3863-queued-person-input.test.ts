import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

async function heldTurn(
	extensionFactories: HarnessOptions["extensionFactories"] = [],
): Promise<{ harness: Harness; release: () => void; done: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	const wait: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await gate.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [wait], extensionFactories });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("after queue"),
		fauxAssistantMessage("after follow-up"),
		fauxAssistantMessage("after another"),
	]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_start") return;
			unsubscribe();
			resolve();
		});
	});
	const done = harness.session.prompt("start");
	await started;
	return { harness, release: gate.resolve, done };
}

describe("queued person input is decided from the entries queued now (senpi#3863)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		["a desktop or RPC client follow-up", { source: "rpc" as const }],
		["a TUI follow-up", { source: "interactive" as const }],
	])("counts %s", async (_label, options) => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);

		await harness.session.followUp("from a person", undefined, options);

		expect(harness.session.hasQueuedPersonInput).toBe(true);
		release();
		await done;
	});

	it("person enqueues, removes it unsent, then an extension enqueues: no person input is queued", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.followUp("changed my mind", undefined, { source: "rpc" });
		const [mine] = harness.session.getQueuedInputs();

		expect(harness.session.dequeueQueuedInput(mine!.queuedId)).toBe("removed");
		await harness.session.sendUserMessage("loop tick", { deliverAs: "followUp" });

		expect(harness.session.pendingMessageCount).toBeGreaterThan(0);
		expect(harness.session.hasQueuedPersonInput).toBe(false);
		release();
		await done;
	});

	it("person enqueues, clears the queue (Esc), then an extension enqueues: no person input is queued", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("never mind", undefined, { source: "interactive" });

		harness.session.clearQueue();
		await harness.session.sendUserMessage("stop hook", { deliverAs: "followUp" });

		expect(harness.session.hasQueuedPersonInput).toBe(false);
		release();
		await done;
	});

	it("an extension's queued message alone is not a person's input", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);

		await harness.session.sendUserMessage("timed-out question", { deliverAs: "followUp" });

		expect(harness.session.pendingMessageCount).toBeGreaterThan(0);
		expect(harness.session.hasQueuedPersonInput).toBe(false);
		release();
		await done;
	});

	it("an answered question delivered through the extension API is a person's input", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, release, done } = await heldTurn([
			(pi) => {
				api = pi;
			},
		]);
		harnesses.push(harness);

		const queued = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.followUp.length > 0) queued.resolve();
		});

		if (api === undefined) throw new Error("the extension factory did not run");
		releaseQuestionInput(harness.session.extensionRunner.createContext());
		api.sendUserMessage("my answer", { deliverAs: "followUp" });
		await queued.promise;

		expect(harness.session.hasQueuedPersonInput).toBe(true);
		release();
		await done;
	});

	it.each([
		["a person's answer", "person" as const, true],
		["an extension's message", "extension" as const, false],
	])(
		"tags %s that the sendUserMessage fallback queues after prompt() rejected: %s",
		async (_label, inputOrigin, person) => {
			const { harness, release, done } = await heldTurn();
			harnesses.push(harness);
			const session = harness.session;
			const prompt = session.prompt.bind(session);
			session.prompt = async () => {
				session.prompt = prompt;
				throw new Error("rejected before a disposition");
			};

			const failure = await session
				.sendUserMessage("my answer", { deliverAs: "followUp" }, undefined, inputOrigin)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toBe("rejected before a disposition");

			expect(session.pendingMessageCount).toBeGreaterThan(0);
			expect(session.hasQueuedPersonInput).toBe(person);
			release();
			await done;
		},
	);

	it("stops counting once the person's input is delivered", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.followUp("then this", undefined, { source: "rpc" });

		release();
		await done;
		await harness.session.waitForIdle();

		expect(harness.session.hasQueuedPersonInput).toBe(false);
	});

	it.each([
		["a person's prompt", {}, true],
		["an extension's prompt", { source: "extension" as const }, false],
	])("tags %s that a competing run displaced into the steer queue: %s", async (_label, origin, person) => {
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
		const displacedQueued = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length > 0) displacedQueued.resolve();
		});

		const displaced = harness.session.prompt("displaced", origin);
		await displacedQueued.promise;

		expect(harness.session.hasQueuedPersonInput).toBe(person);
		release.resolve();
		await displaced;
		await competing;
		await harness.session.waitForSettledSessionWork();
		expect(harness.session.hasQueuedPersonInput).toBe(false);
	});
});
