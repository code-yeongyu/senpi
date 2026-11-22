import type { CustomMessage } from "../../../src/core/messages.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function extra(content: string): CustomMessage {
	return { role: "custom", customType: "ownership-test", content, display: false, timestamp: 1 };
}

function gatedExtra() {
	const value = Promise.withResolvers<CustomMessage>();
	const entered = Promise.withResolvers<void>();
	const then = value.promise.then.bind(value.promise);
	vi.spyOn(value.promise, "then").mockImplementation((resolve, reject) => {
		entered.resolve();
		return then(resolve, reject);
	});
	return { ...value, entered: entered.promise };
}

describe("senpi#4047 release extras custody", () => {
	let harness: Harness;
	afterEach(() => {
		vi.restoreAllMocks();
		harness?.cleanup();
	});

	it("claims each extra once across concurrent idle prompts and preserves a newer capture", async () => {
		// Given a pending extra and two idle prompts preparing concurrently.
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const extras: (CustomMessage | Promise<CustomMessage>)[] = Reflect.get(harness.session, "_releaseExtras");
		const first = gatedExtra();
		const later = gatedExtra();
		extras.push(first.promise);
		const send = vi.spyOn(harness.session.agent, "prompt");

		// When a second capture and idle prompt arrive while the first extra is awaited.
		const one = harness.session.prompt("first");
		await first.entered;
		extras.push(later.promise);
		const two = harness.session.prompt("second");
		await later.entered;
		const newest = extra("newest-capture");
		extras.push(newest);
		first.resolve(extra("first-capture"));
		await one;
		later.resolve(extra("later-capture"));
		await two;

		// Then each claimed extra was sent once and neither completion removed the newer capture.
		const sent = send.mock.calls.flatMap(([messages]) => (Array.isArray(messages) ? messages : [messages]));
		expect(sent.filter((message) => message.role === "custom" && message.content === "first-capture")).toHaveLength(
			1,
		);
		expect(sent.filter((message) => message.role === "custom" && message.content === "later-capture")).toHaveLength(
			1,
		);
		expect(extras).toEqual([newest]);
	});

	it("drops a rejected extra so a later prompt can start", async () => {
		// Given an extra that rejects only after the prompt has claimed it.
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("second")]);
		const extras: (CustomMessage | Promise<CustomMessage>)[] = Reflect.get(harness.session, "_releaseExtras");
		const failing = gatedExtra();
		extras.push(extra("surviving-extra"), failing.promise);
		const send = vi.spyOn(harness.session.agent, "prompt");
		const first = expect(harness.session.prompt("first")).rejects.toThrow("synthetic-extra-failure");
		await failing.entered;

		// When preparation rejects, then another prompt is submitted.
		failing.reject(new Error("synthetic-extra-failure"));
		await first;
		await harness.session.prompt("second");

		// Then the failed extra cannot poison the second prompt.
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls.flatMap(([messages]) => (Array.isArray(messages) ? messages : [messages]))).toContainEqual(
			extra("surviving-extra"),
		);
		expect(extras).toEqual([]);
	});
});
