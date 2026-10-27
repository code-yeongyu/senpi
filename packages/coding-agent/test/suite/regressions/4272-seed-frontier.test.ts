import { carryAssistantCapture, subscribeAssistantCapture } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";
import type { AssistantMessageEvent } from "../../../../ai/src/types.ts";
import { createAssistantMessage } from "../../../../ai/test/tool-call-middleware/stream-wrapper-fixtures.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { subscribeStructuredSessionRecords } from "../../../src/modes/rpc/structured-session-records.ts";
import { scriptedSession, type Lane } from "../structured-lane-support.ts";

let release = () => {};
beforeEach(() => {
	release = subscribeAssistantCapture();
});
afterEach(() => release());

describe("seeded frontier contract #4272", () => {
	it.each([0, 2])("projects producer frontier %s unchanged and keeps legacy bytes", (offset) => {
		const partial = createAssistantMessage([{ type: "text", text: "Hé" }]);
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const event: AssistantMessageEvent = { type: "text_start", contentIndex: 0, partial };
		stream.push(event, { offset });
		stream.end(partial);
		const update = carryAssistantCapture(event, {
			type: "message_update" as const,
			assistantMessageEvent: event,
			message: partial,
		});
		expect(toJsonEvent(update, { blockSeeds: 1 })).toMatchObject({
			assistantMessageEvent: { seed: { coveredCodeUnits: 2, nextOffset: offset } },
		});
		expect(JSON.stringify(toJsonEvent(update))).toBe(
			JSON.stringify({
				type: "message_update",
				usage: partial.usage,
				assistantMessageEvent: {
					type: "text_start",
					contentIndex: 0,
				},
			}),
		);
	});

	it.each([undefined, -1, 1, 3, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects carried seed frontier %s with a typed reason",
		(nextOffset) => {
			const partial = createAssistantMessage([{ type: "text", text: "Hé" }]);
			const stream = new AssistantMessageEventStream({ captureBlocks: true });
			const event: AssistantMessageEvent = { type: "text_start", contentIndex: 0, partial };
			const carried = {
				usage: partial.usage,
				block: partial.content[0],
				coveredCodeUnits: 2,
				...(nextOffset === undefined ? {} : { nextOffset }),
			};
			stream.push(event, { carried });
			stream.end(partial);
			const update = carryAssistantCapture(event, {
				type: "message_update" as const,
				assistantMessageEvent: event,
				message: partial,
			});
			expect(() => toJsonEvent(update, { blockSeeds: 1 })).toThrow(
				expect.objectContaining({
					name: "SeedFrontierError",
					code: nextOffset === undefined ? "missing_next_offset" : "invalid_next_offset",
				}),
			);
		},
	);

	it.each([false, true])("detects replay after continuation, repeated start=%s", async (repeatStart) => {
		const session = await scriptedSession([
			(stream, partial) => {
				stream.push({ type: "start", partial });
				partial.content.push({ type: "text", text: "Hé" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "!", partial });
				if (repeatStart) stream.push({ type: "text_start", contentIndex: 0, partial }, { offset: 0 });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Hé", partial }, { offset: 0 });
				stream.push({ type: "text_end", contentIndex: 0, content: "Hé!", partial });
			},
		]);
		const records: Lane[] = [];
		const stop = subscribeStructuredSessionRecords(session.harness.session, (record) => records.push(record));
		try {
			await session.prompt("go");
			expect(records.filter((record) => record.assistantMessageEvent?.type === "text_start")).toHaveLength(1);
			expect(records.find((record) => record.assistantMessageEvent?.type === "text_start")).toMatchObject({
				assistantMessageEvent: { seed: { nextOffset: 2 } },
			});
			expect(records.filter((record) => record.assistantMessageEvent?.type === "text_delta")).toMatchObject([
				{ assistantMessageEvent: { delta: "!", offset: 2 } },
			]);
			expect(
				records.find((record) => record.type === "message_end" && record.message?.role === "assistant"),
			).toMatchObject({ invalidatedBlocks: [0] });
		} finally {
			stop();
			await session.close();
		}
	});

	it.each([0, 2])(
		"admits contiguous seed schedule %s including empty and boundary-crossing deltas",
		async (offset) => {
			const session = await scriptedSession([
				(stream, partial) => {
					stream.push({ type: "start", partial });
					const block = { type: "text" as const, text: "Hé" };
					partial.content.push(block);
					stream.push({ type: "text_start", contentIndex: 0, partial }, { offset });
					for (const delta of offset === 0 ? ["", "H", "é!"] : ["", "!"])
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
					block.text = "Hé!";
					stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial });
				},
			]);
			const records: Lane[] = [];
			const stop = subscribeStructuredSessionRecords(session.harness.session, (record) => records.push(record));
			try {
				await session.prompt("go");
				expect(records.find((record) => record.assistantMessageEvent?.type === "text_start")).toMatchObject({
					assistantMessageEvent: { seed: { coveredCodeUnits: 2, nextOffset: offset } },
				});
				expect(
					records
						.filter((record) => record.assistantMessageEvent?.type === "text_delta")
						.map((record) => record.assistantMessageEvent?.offset),
				).toEqual(offset === 0 ? [0, 0, 1] : [2, 2]);
				const end = records.find((record) => record.type === "message_end" && record.message?.role === "assistant");
				expect(end).toMatchObject({ message: { content: [{ type: "text", text: "Hé!" }] } });
				expect(end?.invalidatedBlocks).toBeUndefined();
			} finally {
				stop();
				await session.close();
			}
		},
	);
});
