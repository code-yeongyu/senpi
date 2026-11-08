import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { DeviceProxyEgress } from "../../src/core/egress/device-proxy-ports.ts";
import { requestPrefix } from "../../src/core/egress/ledger-schema.ts";
import { hostDouble, storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, rig, serverRoute, tagRequest, transcript } from "./device-proxy-fixture.ts";

async function settle(
	egress: DeviceProxyEgress,
	model: Parameters<DeviceProxyEgress["stream"]>[0],
	ctx = transcript(),
) {
	const stream = await egress.stream(model, ctx, {});
	for await (const _event of stream);
	return stream.result();
}

async function hungFirstAttempt(fault: "hang-after-hooks" | "hang-after-hooked" | "hang-after-events") {
	const fixture = await storeFixture();
	const faux = fauxModel();
	faux.reply("first");
	const hooksRun = fault !== "hang-after-events";
	const first = await rig({
		store: await fixture.open(),
		respond: faux.respond,
		...(hooksRun ? { requestHook: tagRequest } : {}),
	});
	const hand = handOf(first);
	hand.fault(fault === "hang-after-events" ? { kind: fault, events: 0 } : { kind: fault });
	const written = first.commits.reached(fault === "hang-after-hooked" ? 2 : 1);
	void first.egress.stream(faux.model, transcript(), {});
	await written;
	await hand.started(1);
	const [row] = await first.ledger.rowsForStep("step-1");
	if (!row) throw new Error("no W4 row");
	hand.forget(row.callId);
	return { fixture, faux, first, hand, row };
}

describe("device-proxy egress: re-admission replay rules (CK9; design 4.5)", () => {
	it("replays an ended success without contacting the device or running hooks", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("stored answer");
		const first = await rig({ store: await fixture.open(), respond: faux.respond, requestHook: tagRequest });
		const original = await settle(first.egress, faux.model);
		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		const replayed = await settle(again.egress, faux.model, transcript("a different, time-dependent prompt"));
		const hand = handOf(again);
		expect(replayed).toEqual(original);
		expect(hand.starts).toHaveLength(1);
		expect(hand.resultQueries).toEqual([]);
		expect(hand.hookRuns).toBe(1);
		expect(again.hookRequests).toEqual([]);
	});

	it("never replays an ended error: re-admission dials again with the stored request and closes the error row", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("second try");
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		handOf(first).fault({ kind: "error", code: "unavailable", retryable: true });
		const failed = await settle(first.egress, faux.model);
		expect(failed.stopReason).toBe("error");

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		const answer = await settle(again.egress, faux.model, transcript("changed since"));
		const hand = handOf(again);
		const rows = await again.ledger.rowsForStep("step-1");
		expect(answer.content).toEqual([{ type: "text", text: "second try" }]);
		expect(hand.starts.map((start) => start.call)).toEqual([
			{ kind: "step", stepId: "step-1", attempt: 1 },
			{ kind: "step", stepId: "step-1", attempt: 2 },
		]);
		expect(hand.starts[1]?.request).toEqual(hand.starts[0]?.request);
		expect(rows.map((row) => row.state)).toEqual(["closed", "ended"]);
	});

	it("never replays an ended row whose terminal event is a provider error", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.replyMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }));
		faux.reply("recovered");
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		expect((await settle(first.egress, faux.model)).stopReason).toBe("error");
		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		expect((await settle(again.egress, faux.model)).content).toEqual([{ type: "text", text: "recovered" }]);
		expect(handOf(again).starts).toHaveLength(2);
	});

	it("never replays an ended row whose stop is still pending: re-admission dials again", async () => {
		const { fixture, faux, first, row } = await hungFirstAttempt("hang-after-events");
		const pending = fauxAssistantMessage("half an answer", { stopReason: "pending" });
		await first.ledger.end(row, { kind: "message", message: pending });
		faux.reply("finished");
		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		expect((await settle(again.egress, faux.model)).content).toEqual([{ type: "text", text: "finished" }]);
		expect(handOf(again).starts).toHaveLength(2);
	});

	it("dials nothing for a step whose history row exists", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		const host = hostDouble();
		host.history.add("step-1");
		const r = await rig({ store, respond: faux.respond, host });
		await expect(settle(r.egress, faux.model)).rejects.toThrow(/already committed/);
		expect(handOf(r).starts).toEqual([]);
		expect(await r.ledger.rowsForStep("step-1")).toEqual([]);
	});

	it("never redials a cancelled step: it answers the aborted message (W14)", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		const r = await rig({ store, respond: faux.respond });
		await r.ledger.cancelStep("step-1", undefined);
		const message = await settle(r.egress, faux.model);
		expect(message.stopReason).toBe("aborted");
		expect(handOf(r).starts).toEqual([]);
	});

	it("reissues the stored request byte-for-byte when the device lost the call, and drops the lost row's request", async () => {
		const { fixture, faux, hand, row } = await hungFirstAttempt("hang-after-events");
		faux.reply("reissued");
		const store = await fixture.open();
		const again = await rig({
			store,
			respond: faux.respond,
			hands: new Map([["laptop", hand]]),
		});
		const answer = await settle(again.egress, faux.model, transcript("a prompt rebuilt at a later time"));
		expect(answer.content).toEqual([{ type: "text", text: "reissued" }]);
		expect(hand.starts).toHaveLength(2);
		expect(JSON.stringify(hand.starts[1]?.request)).toBe(JSON.stringify(hand.starts[0]?.request));
		expect(hand.cancels).toEqual([{ t: "provider.call.cancel", callId: row.callId, reason: "superseded" }]);
		expect(await store.scanDocuments(requestPrefix(row.callId))).toEqual([]);
		expect(again.notices).toContainEqual({
			t: "step.reset",
			sessionId: "session-1",
			stepId: "step-1",
			cause: "superseded",
		});
	});

	it("reissues to the hand with hooks disabled once `hooked` was stored", async () => {
		const { fixture, faux, hand } = await hungFirstAttempt("hang-after-hooked");
		faux.reply("no second hook run");
		const again = await rig({
			store: await fixture.open(),
			respond: faux.respond,
			hands: new Map([["laptop", hand]]),
		});
		await settle(again.egress, faux.model);
		expect(hand.starts.map((start) => start.hooks)).toEqual(["enabled", "disabled"]);
		expect(hand.hookRuns).toBe(1);
		expect(JSON.stringify(hand.starts[1]?.request)).toContain("[hooked]");
	});

	it("reissues to the hand with hooks enabled when it died after the hooks but before `hooked` (honest window)", async () => {
		const { fixture, faux, hand } = await hungFirstAttempt("hang-after-hooks");
		faux.reply("hooks ran twice");
		const again = await rig({
			store: await fixture.open(),
			respond: faux.respond,
			hands: new Map([["laptop", hand]]),
		});
		await settle(again.egress, faux.model);
		expect(hand.starts.map((start) => start.hooks)).toEqual(["enabled", "enabled"]);
		expect(hand.hookRuns).toBe(2);
	});

	it("runs the request hooks on the hand first when reissuing to another server without them applied", async () => {
		const { fixture, faux, first, hand } = await hungFirstAttempt("hang-after-hooks");
		faux.reply("served by the desktop");
		const desktop = await rig({ store: await fixture.open(), respond: faux.respond, devices: ["desktop"] });
		const hands = new Map([...first.hands, ...desktop.hands]);
		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands });
		again.route.decision = () => serverRoute("desktop", "laptop");
		await settle(again.egress, faux.model);
		const [served] = handOf(again, "desktop").starts;
		const [row] = (await again.ledger.rowsForStep("step-1")).slice(-1);
		expect(again.hookRequests.map((entry) => entry.hand)).toEqual(["laptop"]);
		expect(served?.hooks).toBe("disabled");
		expect(JSON.stringify(served?.request)).toContain("[hooked]");
		expect(row?.hooksApplied).toBe(true);
		expect(hand.starts).toHaveLength(1);
	});
});
