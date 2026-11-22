import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { closeCallWrites } from "../../src/core/egress/ledger.ts";
import { callKey, REQUEST_CHUNK_BYTES, resultPrefix } from "../../src/core/egress/ledger-schema.ts";
import { ledgerOn, storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, rig, transcript } from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

describe("device-proxy egress: the ended result is the assembled message, chunked (CK9; design 4.5)", () => {
	it("keeps the row small however many events the answer streamed, and replays the stored message", async () => {
		const fixture = await storeFixture();
		const store = await fixture.open();
		const faux = fauxModel();
		faux.reply("streamed in many deltas ".repeat(700));
		const first = await rig({ store, respond: faux.respond });
		const original = await drain(await first.egress.stream(faux.model, transcript(), {}));
		const [row] = await first.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(utf8Bytes(JSON.stringify(await store.getDocument(callKey(row.callId))))).toBeLessThan(4096);

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		const replayed = await drain(await again.egress.stream(faux.model, transcript(), {}));
		expect(replayed).toEqual(original);
		expect(handOf(again).resultQueries).toEqual([]);

		await store.commit(1, closeCallWrites(row), () => {});
		expect(await store.scanDocuments(resultPrefix(row.callId))).toEqual([]);
	});

	it("stores a message larger than one store value in 96 KiB chunks and reads it back whole", async () => {
		const store = await (await storeFixture()).open();
		const ledger = ledgerOn(store);
		const row = await ledger.dispatch(
			{
				callId: "call-big",
				sessionId: "session-1",
				call: { kind: "step", stepId: "step-1", attempt: 1 },
				route: "device",
				deviceId: "laptop",
				providerId: "faux",
				modelId: "m",
				epoch: 1,
				capability: "stream",
				hooksApplied: false,
			},
			"{}",
		);
		const message: AssistantMessage = fauxAssistantMessage("\u00e9".repeat(512 * 1024));
		const ended = await ledger.end(row, { kind: "message", message });
		const chunks = await store.scanDocuments(resultPrefix(row.callId));
		expect(chunks.length).toBeGreaterThan(10);
		for (const chunk of chunks) expect(utf8Bytes(String(chunk.data))).toBeLessThanOrEqual(REQUEST_CHUNK_BYTES);
		expect(await ledger.readMessage(ended)).toEqual(message);
		expect(ended.result).toMatchObject({ kind: "message", stopReason: "stop", chunks: chunks.length });
	});
});
