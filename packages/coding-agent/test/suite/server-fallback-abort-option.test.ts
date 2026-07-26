import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

async function captureStreamOptions(harness: Harness): Promise<SimpleStreamOptions[]> {
	const captured: SimpleStreamOptions[] = [];
	const inner = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (model, context, options) => {
		captured.push(options ?? {});
		return inner(model, context, options);
	};
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("hello");
	return captured;
}

describe("abortServerSideFallback reaches the provider options", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("forwards the default (enabled) to the stream function", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.abortServerSideFallback).toBe(true);
	});

	it("forwards an explicit opt-out", async () => {
		const harness = await createHarness({ settings: { retry: { abortServerSideFallback: false } } });
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});
});
