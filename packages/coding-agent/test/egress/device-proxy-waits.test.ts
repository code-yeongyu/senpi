import type { EgressRouteDecision } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { requestPrefix } from "../../src/core/egress/ledger-schema.ts";
import { storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, handRoute, rig, transcript } from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

const waitFor = (deviceId: string): EgressRouteDecision => ({
	route: "device",
	reason: "custody:device",
	deviceId,
	servedNow: false,
	steer: `open omo on ${deviceId}`,
	waitFor: [{ kind: "device-online", deviceId }],
});

describe("device-proxy egress: waits, liveness and aborts (CK9; design 2.3, 4.4)", () => {
	it("holds a not-served route as tracked local work bracketed by onWait/onWaitEnd, dialing nothing", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("served after the wait");
		const r = await rig({ store, respond: faux.respond });
		let online = false;
		r.route.decision = () => (online ? handRoute() : waitFor("laptop"));
		const waiting = r.conditions.nextWait();
		const stream = await r.egress.stream(faux.model, transcript(), {});
		expect(await waiting).toEqual([{ kind: "device-online", deviceId: "laptop" }]);
		expect(stream.hasPendingLocalWork()).toBe(true);
		expect(r.host.waits.map((wait) => [wait.reason, wait.steer])).toEqual([["custody:device", "open omo on laptop"]]);
		expect(handOf(r).starts).toEqual([]);
		online = true;
		r.conditions.release();
		expect((await drain(stream)).content).toEqual([{ type: "text", text: "served after the wait" }]);
		expect(r.host.waitEnds).toEqual(["step-1"]);
	});

	it("waits for the pinned device of a dispatched row and never dispatches it elsewhere", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("finished on the laptop");
		const deadAfterW4 = await fixture.open({ nth: 2, at: "before" });
		const first = await rig({ store: deadAfterW4, respond: faux.respond, devices: ["laptop", "desktop"] });
		const laptop = handOf(first);
		laptop.fault({ kind: "hang-after-events", events: 0 });
		const written = first.commits.reached(1);
		void first.egress.stream(faux.model, transcript(), {});
		await written;
		await handOf(first).started(1);
		const [row] = await first.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		again.route.decision = () => handRoute("desktop");
		again.offline.set("laptop", 10_000);
		const waiting = again.conditions.nextWait();
		const stream = await again.egress.stream(faux.model, transcript(), {});
		expect(await waiting).toEqual([{ kind: "device-online", deviceId: "laptop" }]);
		again.offline.set("laptop", 0);
		again.conditions.release();
		await laptop.finish(row.callId);
		expect((await drain(stream)).content).toEqual([{ type: "text", text: "finished on the laptop" }]);
		expect(handOf(again, "desktop").starts).toEqual([]);
		expect(laptop.cancels).toEqual([]);
	});

	it("bounds a silent hand: after one idle window plus one resume window it cancels{budget} with the idle text", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("never finishes");
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.fault({ kind: "hang-after-events", events: 0 });
		let sleeping = r.clock.nextSleep();
		const stream = await r.egress.stream(faux.model, transcript(), {});
		const failed = drain(stream).then(
			() => "completed",
			(error: unknown) => String(error),
		);
		const probes: number[] = [];
		for (let probe = 0; probe < 10; probe++) {
			const next = await Promise.race([sleeping, failed]);
			if (typeof next === "string") break;
			probes.push(next);
			sleeping = r.clock.nextSleep();
			r.clock.advance(30_000);
		}
		expect(await failed).toBe("Error: Idle timeout waiting for provider stream after 60000ms");
		expect(probes).toEqual([30_000, 30_000, 30_000]);
		expect(hand.resultQueries).toHaveLength(2);
		expect(hand.cancels.map((cancel) => cancel.reason)).toEqual(["budget"]);
	});

	it("ignores a presence blip, waits once offline outlasts the resume window, and never cancels for it", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("survived the outage");
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.fault({ kind: "hang-after-events", events: 0 });
		let sleeping = r.clock.nextSleep();
		const stream = await r.egress.stream(faux.model, transcript(), {});
		await sleeping;
		r.offline.set("laptop", 1_000);
		sleeping = r.clock.nextSleep();
		r.clock.advance(30_000);
		await sleeping;
		expect(r.conditions.seen).toEqual([]);
		r.offline.set("laptop", 6_000);
		const waiting = r.conditions.nextWait();
		r.clock.advance(30_000);
		expect(await waiting).toEqual([{ kind: "device-online", deviceId: "laptop" }]);
		r.offline.set("laptop", 0);
		r.conditions.release();
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		await hand.finish(row.callId);
		expect((await drain(stream)).content).toEqual([{ type: "text", text: "survived the outage" }]);
		expect(hand.cancels).toEqual([]);
	});

	it("writes step.cancelled (W14) on a user abort, cancels{user}, drops the request and fails with the abort text", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("aborted");
		const store = await fixture.open();
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.fault({ kind: "hang-after-events", events: 0 });
		const controller = new AbortController();
		const written = r.commits.reached(1);
		const stream = await r.egress.stream(faux.model, transcript(), { signal: controller.signal });
		await written;
		await hand.started(1);
		controller.abort();
		await expect(drain(stream)).rejects.toThrow("Request was aborted");
		const [row] = await r.ledger.rowsForStep("step-1");
		expect(await r.ledger.isCancelled("step-1")).toBe(true);
		expect(row?.state).toBe("cancelled");
		expect(hand.cancels).toEqual([{ t: "provider.call.cancel", callId: row?.callId, reason: "user" }]);
		expect(await store.scanDocuments(requestPrefix(row?.callId ?? ""))).toEqual([]);

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: r.hands });
		expect((await drain(await again.egress.stream(faux.model, transcript(), {}))).stopReason).toBe("aborted");
		expect(hand.starts).toHaveLength(1);
	});

	it("asks the user before any reissue of a callback-stream step", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("lost with the device");
		faux.reply("rerun after the choice");
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		const hand = handOf(first);
		hand.fault({ kind: "hang-after-events", events: 0 });
		const written = first.commits.reached(1);
		void first.egress.stream(faux.model, transcript(), {});
		await written;
		await handOf(first).started(1);
		const [row] = await first.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		hand.forget(row.callId);

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		again.route.capability = "callback-stream";
		const waiting = again.conditions.nextWait();
		const stream = await again.egress.stream(faux.model, transcript(), {});
		const [choice] = await waiting;
		expect(choice?.kind).toBe("user-choice");
		expect(hand.starts).toHaveLength(1);
		again.conditions.release();
		expect((await drain(stream)).content).toEqual([{ type: "text", text: "rerun after the choice" }]);
		expect(hand.starts.map((start) => start.call)).toEqual([
			{ kind: "step", stepId: "step-1", attempt: 1 },
			{ kind: "step", stepId: "step-1", attempt: 2 },
		]);
	});

	it("leaves a superseded row superseded when the user aborts while the reissue waits", async () => {
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

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		again.route.capability = "callback-stream";
		const controller = new AbortController();
		const waiting = again.conditions.nextWait();
		const stream = await again.egress.stream(faux.model, transcript(), { signal: controller.signal });
		await waiting;
		controller.abort();
		await expect(drain(stream)).rejects.toThrow("Request was aborted");
		const rows = await again.ledger.rowsForStep("step-1");
		expect(rows.map((entry) => entry.state)).toEqual(["superseded"]);
		expect(await again.ledger.isCancelled("step-1")).toBe(true);
		expect(hand.cancels.map((cancel) => cancel.reason)).toEqual(["superseded"]);
	});
});
