import { getEventListeners } from "node:events";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { abortion } from "../../src/core/egress/device-proxy-waits.ts";
import { storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, probeUntilSettled, rig, transcript } from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

describe("device-proxy egress: liveness over an unreliable events stream (CK9; design 4.4)", () => {
	it("keeps the idle bound when the events stream ends while the hand still reports running", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("never finishes");
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.fault({ kind: "hang-after-events", events: 0 });
		hand.readerFault("cut");
		hand.limitResultQueries(20);
		const sleeping = r.clock.nextSleep();
		const outcome = await probeUntilSettled(r, await r.egress.stream(faux.model, transcript(), {}), sleeping);
		expect(outcome).toEqual({ error: "Error: Idle timeout waiting for provider stream after 60000ms" });
		expect(hand.cancels.map((cancel) => cancel.reason)).toEqual(["budget"]);
		expect(hand.resultQueries.length).toBeLessThanOrEqual(3);
	});

	it("settles from the next probe once the hand finishes after its events stream ended", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("finished after the stream dropped");
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.fault({ kind: "hang-after-events", events: 0 });
		hand.readerFault("cut");
		hand.limitResultQueries(20);
		const firstTick = r.clock.nextSleep();
		const stream = await r.egress.stream(faux.model, transcript(), {});
		await firstTick;
		const afterStreamEnded = r.clock.nextSleep();
		await afterStreamEnded;
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		await hand.finish(row.callId);
		const outcome = await probeUntilSettled(r, stream, afterStreamEnded);
		expect(outcome).toMatchObject({
			message: { content: [{ type: "text", text: "finished after the stream dropped" }] },
		});
		expect(hand.cancels).toEqual([]);
	});

	it("closes the dropped events stream when it re-attaches, and every stream once the call ends", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("after the re-attach");
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.fault({ kind: "hang-after-events", events: 1 });
		hand.readerFault("stall");
		const sleeping = r.clock.nextSleep();
		const stream = await r.egress.stream(faux.model, transcript(), {});
		await hand.started(1);
		hand.readerFault("none");
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		const reattached = r.clock.nextSleep();
		await sleeping;
		r.clock.advance(30_000);
		await reattached;
		await hand.finish(row.callId);
		expect((await drain(stream)).content).toEqual([{ type: "text", text: "after the re-attach" }]);
		expect(hand.openReaders()).toBe(0);
	});

	it("adds one abort listener per signal however many waits race it", () => {
		const controller = new AbortController();
		for (let wait = 0; wait < 50; wait++) void abortion(controller.signal);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
	});
});
