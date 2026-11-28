import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { QueuedInputDispositions } from "../../src/core/queued-input-dispositions.ts";
import { handleClientInput } from "../../src/modes/rpc/client-input-handler.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

async function streamingHarness(onQueued?: () => Promise<void>) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const log: string[] = [];
	const textById = new Map<string, string>();
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("input", (event) => {
					textById.set(event.inputId, event.text);
				});
				pi.on("input_disposition", (event) => {
					log.push(`${textById.get(event.inputId)}:${event.disposition}`);
					if (event.disposition === "queued") return onQueued?.();
				});
				pi.on("message_start", (event) => {
					if (event.message.role === "user") log.push(`${getMessageText(event.message)}:message_start`);
				});
			},
		],
		tools: [
			{
				name: "barrier",
				label: "Barrier",
				description: "Wait for the test.",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])),
	]);
	return { h, entered, release, log };
}

describe("input_disposition for input queued while a turn runs (senpi#4482)", () => {
	// senpi#7579: the tool finishes while extension notification of the queued steer is still pending.
	it("answers the RPC prompt before announcing or delivering its queued input", async () => {
		const notifying = Promise.withResolvers<void>();
		const notified = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const { h, entered, release } = await streamingHarness(() => {
			notifying.resolve();
			return notified.promise;
		});
		const frames: unknown[] = [];
		h.session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.includes("queued input")) frames.push(event.type);
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued input"
			) {
				frames.push(event.type);
				delivered.resolve();
			}
		});
		const running = h.session.prompt("start");
		await entered.promise;
		const admission = handleClientInput(
			h.session,
			{ id: "steering", type: "prompt", streamingBehavior: "steer", message: "queued input" },
			{ output: (frame) => frames.push(frame), promptCalls: new Set() },
		);
		try {
			await notifying.promise;
			release.resolve();
			await delivered.promise;
		} finally {
			notified.resolve();
			release.resolve();
			await Promise.all([admission, running]);
		}
		expect(frames).toEqual([
			expect.objectContaining({ id: "steering", success: true, data: { disposition: "queued" } }),
			"queue_update",
			"message_start",
		]);
	});

	it.each([
		["steer", (h: Harness) => h.session.steer("queued input")],
		["follow-up", (h: Harness) => h.session.followUp("queued input")],
		["streaming prompt", (h: Harness) => h.session.prompt("queued input", { streamingBehavior: "steer" })],
	] as const)("reports a %s as queued when it is queued and started when it is delivered", async (_kind, send) => {
		const { h, entered, release, log } = await streamingHarness();
		const running = h.session.prompt("start");
		await entered.promise;
		try {
			await send(h);
			expect(log.filter((line) => line.startsWith("queued input"))).toEqual(["queued input:queued"]);
		} finally {
			release.resolve();
			await running;
			await h.session.waitForIdle();
		}
		expect(log.filter((line) => line.startsWith("queued input"))).toEqual([
			"queued input:queued",
			"queued input:started",
			"queued input:message_start",
		]);
	});
});

describe("QueuedInputDispositions", () => {
	it("reports started after queued even when delivery lands while queued is still being reported", async () => {
		const emitted: string[] = [];
		const queuedHandled = Promise.withResolvers<void>();
		const queuedEntered = Promise.withResolvers<void>();
		const dispositions = new QueuedInputDispositions(async (inputId, disposition) => {
			if (disposition === "queued") {
				queuedEntered.resolve();
				await queuedHandled.promise;
			}
			emitted.push(`${inputId}:${disposition}`);
		});
		const message = {};
		dispositions.track(message, "i1");
		const queued = dispositions.queued("i1");
		await queuedEntered.promise;
		await dispositions.delivered(message);
		expect(emitted).toEqual([]);
		queuedHandled.resolve();
		await queued;
		expect(emitted).toEqual(["i1:queued", "i1:started"]);
	});

	it("reports started once, and nothing for messages it never tracked", async () => {
		const emitted: string[] = [];
		const dispositions = new QueuedInputDispositions(async (inputId, disposition) => {
			emitted.push(`${inputId}:${disposition}`);
		});
		const message = {};
		dispositions.track(message, "i1");
		await dispositions.queued("i1");
		await dispositions.delivered(message);
		await dispositions.delivered(message);
		await dispositions.delivered({});
		await dispositions.queued(undefined);
		expect(emitted).toEqual(["i1:queued", "i1:started"]);
	});
});
