import type { DurableStore } from "@earendil-works/pi-agent-core/conformance";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { requestPrefix } from "../../src/core/egress/ledger-schema.ts";
import { storeFixture } from "./device-proxy-doubles.ts";
import { type EgressRig, fauxModel, handOf, rig, transcript } from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

async function chunksLeft(r: EgressRig, store: DurableStore): Promise<number> {
	const rows = await r.ledger.rowsForStep("step-1");
	const counts = await Promise.all(rows.map((row) => store.scanDocuments(requestPrefix(row.callId))));
	return counts.reduce((sum, chunks) => sum + chunks.length, 0);
}

/** W14 under 4.5 retention: the step is cancelled and no stored request is left. */
async function abortAndCheck(
	r: EgressRig,
	store: DurableStore,
	stream: AssistantMessageEventStream,
	controller: AbortController,
) {
	controller.abort();
	await expect(drain(stream)).rejects.toThrow("Request was aborted");
	expect(await r.ledger.isCancelled("step-1")).toBe(true);
	expect(await chunksLeft(r, store)).toBe(0);
	return (await r.ledger.rowsForStep("step-1")).map((row) => row.state);
}

describe("device-proxy egress: a user abort during a reissue wait deletes the stored request (CK9 W14; design 4.5)", () => {
	it("during the lost-call pacer backoff", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		const r = await rig({ store, respond: faux.respond });
		handOf(r).amnesiac();
		const controller = new AbortController();
		const backoff = r.clock.nextSleep(5_000);
		const stream = await r.egress.stream(faux.model, transcript(), { signal: controller.signal });
		await backoff;
		expect(await abortAndCheck(r, store, stream, controller)).toEqual(["superseded", "superseded"]);
	});

	it("during the result-pending choice after the automatic reissues", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		const r = await rig({ store, respond: faux.respond });
		handOf(r).amnesiac();
		const controller = new AbortController();
		const backoff = r.clock.nextSleep(5_000);
		const stream = await r.egress.stream(faux.model, transcript(), { signal: controller.signal });
		await backoff;
		const choice = r.conditions.nextWait();
		r.clock.advance(5_000);
		expect(await choice).toEqual([{ kind: "user-choice", choiceId: "step-1:4" }]);
		expect(await abortAndCheck(r, store, stream, controller)).toEqual(["superseded", "superseded", "superseded"]);
	});

	it("during the callback-stream choice after a lost call", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("lost with the device");
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		const hand = handOf(first);
		hand.fault({ kind: "hang-after-events", events: 0 });
		const written = first.commits.reached(1);
		void first.egress.stream(faux.model, transcript(), {});
		await written;
		await hand.started(1);
		const [row] = await first.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		hand.forget(row.callId);

		const store = await fixture.open();
		const again = await rig({ store, respond: faux.respond, hands: first.hands });
		again.route.capability = "callback-stream";
		const controller = new AbortController();
		const waiting = again.conditions.nextWait();
		const stream = await again.egress.stream(faux.model, transcript(), { signal: controller.signal });
		expect((await waiting)[0]?.kind).toBe("user-choice");
		expect(await abortAndCheck(again, store, stream, controller)).toEqual(["superseded"]);
	});

	it("during the callback-stream choice before redialing a step whose attempt ended in an error", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		first.route.capability = "callback-stream";
		handOf(first).fault({ kind: "error", code: "unavailable", retryable: true });
		expect((await drain(await first.egress.stream(faux.model, transcript(), {}))).stopReason).toBe("error");

		const store = await fixture.open();
		const again = await rig({ store, respond: faux.respond, hands: first.hands });
		again.route.capability = "callback-stream";
		const controller = new AbortController();
		const waiting = again.conditions.nextWait();
		const stream = await again.egress.stream(faux.model, transcript(), { signal: controller.signal });
		expect(await waiting).toEqual([{ kind: "user-choice", choiceId: "step-1:2" }]);
		expect(await abortAndCheck(again, store, stream, controller)).toEqual(["cancelled"]);
		expect(handOf(again).starts).toHaveLength(1);
	});
});
