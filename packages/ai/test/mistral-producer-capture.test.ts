import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel } from "../src/compat.ts";
import type { FetchFunction } from "../src/types.ts";
import { getAssistantCapture } from "../src/utils/assistant-capture.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	mintedIdentityKeys,
	publicBytes,
	publicEvents,
	recordKinds,
	subscribeCaptureForEachTest,
} from "./producer-capture-records.ts";

subscribeCaptureForEachTest();

const model = getModel("mistral", "devstral-medium-latest");
const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const stringArguments = ['{ "text": ', '"a\\tb" }'];
const objectArguments = { n: 2, unit: "x y" };

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
	return { id: "mistral-response", model: model.id, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function wire(): FetchFunction {
	const chunks = [
		chunk({ content: "Hel" }),
		chunk({ content: "lo" }),
		...stringArguments.map((args) =>
			chunk({ tool_calls: [{ id: "call_1", index: 0, function: { name: "echo", arguments: args } }] }),
		),
		chunk({ tool_calls: [{ id: "call_2", index: 1, function: { name: "count", arguments: objectArguments } }] }),
		{ ...chunk({}, "tool_calls"), usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
	];
	const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
	return async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function capture() {
	return drainRecords(streamMistral(model, context, { apiKey: "fixture", fetch: wire() }));
}

describe("Mistral producer capture #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture()))).toMatchSnapshot();
	});

	it("freezes empty tool seeds and keeps the spelling the adapter emitted", async () => {
		const records = await capture();
		expect(recordKinds(records)).toEqual([
			"start",
			"text_start:0",
			"text_delta:0",
			"text_delta:0",
			"text_end:0",
			"toolcall_start:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:1",
			"toolcall_end:2",
			"done",
		]);
		const events = publicEvents(records);
		for (const contentIndex of [1, 2])
			expect(getAssistantCapture(firstEvent(events, "toolcall_start", contentIndex))).toMatchObject({
				block: { type: "toolCall", arguments: {} },
				rawArgumentPrefix: "",
				parsedThrough: 0,
				coveredCodeUnits: 0,
			});
		// Object arguments reach the stream as the adapter's own serialization, which is what readers saw.
		expect(deltaCaptures(events, "toolcall_delta")).toEqual([
			{ delta: stringArguments[0], offset: 0, parsedThrough: 10 },
			{ delta: stringArguments[1], offset: 10, parsedThrough: 18 },
			{ delta: '{"n":2,"unit":"x y"}', offset: 0, parsedThrough: 20 },
		]);
		expect(deltaCaptures(events, "text_delta")).toEqual([
			{ delta: "Hel", offset: 0, parsedThrough: undefined },
			{ delta: "lo", offset: 3, parsedThrough: undefined },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 1))?.block).toMatchObject({
			arguments: { text: "a\tb" },
		});
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 2))?.block).toMatchObject({
			arguments: objectArguments,
		});
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "toolUse" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
