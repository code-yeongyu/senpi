import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createLiveDigestBoard } from "../../src/core/egress/device-proxy-waits.ts";
import { HOUR, NOW } from "./claim-fixture.ts";
import { ledgerOn, storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, handRoute, rig, serverRoute, transcript } from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

describe("device-proxy egress: claims and definition variants (CK9; design 4.2, 4.6)", () => {
	it("renews an expired placement claim and starts the step again under a new callId (a duplicate start is a result query)", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("after renewal");
		const claimOverrides = { issuedAt: NOW - 3 * HOUR, expiresAt: NOW - HOUR };
		const r = await rig({ store, respond: faux.respond, claimOverrides });
		const message = await drain(await r.egress.stream(faux.model, transcript(), {}));
		const hand = handOf(r);
		expect(message.content).toEqual([{ type: "text", text: "after renewal" }]);
		const [refused, served] = hand.starts.map((start) => start.callId);
		const rows = await r.ledger.rowsForStep("step-1");
		expect(r.claimRenewals).toEqual(["claim_expired"]);
		expect(hand.starts).toHaveLength(2);
		expect(refused).not.toBe(served);
		expect(hand.starts.map((start) => start.call)).toEqual([
			{ kind: "step", stepId: "step-1", attempt: 1 },
			{ kind: "step", stepId: "step-1", attempt: 1 },
		]);
		expect(rows.map((row) => [row.callId, row.state])).toEqual([[served, "ended"]]);
		expect(hand.acks).toEqual([refused, served]);
		expect(r.notices).toEqual([]);
		expect(r.host.waits.map((wait) => wait.waitFor)).toEqual([[{ kind: "claim-renewed" }]]);
	});

	it("waits with a 5 s backoff while the hand cannot check the registry key, then retries", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("after the key check");
		const r = await rig({ store, respond: faux.respond });
		handOf(r).fault({ kind: "error", code: "registry_key_unknown", retryable: true });
		const sleeping = r.clock.nextSleep(5_000);
		const stream = await r.egress.stream(faux.model, transcript(), {});
		expect(await sleeping).toBe(5_000);
		expect(stream.hasPendingLocalWork()).toBe(true);
		const retried = handOf(r).started(2);
		r.clock.advance(5_000);
		await retried;
		const second = r.clock.nextSleep(10_000);
		const settled = drain(stream).then((message) => message.content);
		const next = await Promise.race([settled, second.then(() => "backed off again on the stored refusal")]);
		expect(next).toEqual([{ type: "text", text: "after the key check" }]);
		const callIds = handOf(r).starts.map((start) => start.callId);
		expect(new Set(callIds).size).toBe(2);
	});

	it("ends the step with an error row on a non-retryable refusal and does not retry", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		const r = await rig({ store, respond: faux.respond });
		handOf(r).fault({ kind: "error", code: "stale_epoch" });
		const message = await drain(await r.egress.stream(faux.model, transcript(), {}));
		const [row] = await r.ledger.rowsForStep("step-1");
		expect(message.stopReason).toBe("error");
		expect(row?.result).toMatchObject({ kind: "error", code: "stale_epoch" });
		expect(handOf(r).starts).toHaveLength(1);
	});

	it("records the variant with the live digest, supersedes the row and reissues to the next server", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("served by the desktop");
		const r = await rig({ store, respond: faux.respond, devices: ["laptop", "desktop"] });
		r.route.decision = (variants) => (variants.has("laptop") ? serverRoute("desktop") : handRoute("laptop"));
		r.route.live.set("laptop", "live-1");
		handOf(r, "laptop").fault({ kind: "error", code: "definition_mismatch" });
		const message = await drain(await r.egress.stream(faux.model, transcript(), {}));
		const [first, second] = await r.ledger.rowsForStep("step-1");
		expect(message.content).toEqual([{ type: "text", text: "served by the desktop" }]);
		expect(await r.ledger.variants("faux")).toEqual(
			new Map([["laptop", { headDigest: "digest-head", liveAtMismatch: "live-1", mismatches: 1 }]]),
		);
		expect([first?.state, second?.state, second?.deviceId]).toEqual(["superseded", "ended", "desktop"]);
		expect(handOf(r, "desktop").starts[0]?.request).toEqual(handOf(r, "laptop").starts[0]?.request);
		expect(r.notices).toContainEqual({
			t: "step.reset",
			sessionId: "session-1",
			stepId: "step-1",
			cause: "superseded",
		});
	});

	it("counts mismatches per (device, step) and restarts the count when the head digest changes", async () => {
		const ledger = ledgerOn(await (await storeFixture()).open());
		const mismatch = (stepId: string, headDigest: string) =>
			ledger.recordVariant({ providerId: "p", deviceId: "laptop", stepId, headDigest, liveAtMismatch: undefined });
		await mismatch("step-1", "head-a");
		await mismatch("step-1", "head-a");
		expect((await ledger.variants("p")).get("laptop")?.mismatches).toBe(2);
		await mismatch("step-1", "head-b");
		expect((await ledger.variants("p")).get("laptop")).toEqual({
			headDigest: "head-b",
			liveAtMismatch: undefined,
			mismatches: 1,
		});
		await mismatch("step-2", "head-b");
		expect((await ledger.variants("p")).get("laptop")?.mismatches).toBe(1);
	});

	it("wakes a live-digest-change wait only when the reported digest changes", async () => {
		const board = createLiveDigestBoard();
		const presence = (digest: string) => ({
			deviceId: "laptop",
			online: true,
			capabilities: [],
			liveDigests: { p: digest },
		});
		board.report(presence("live-1"));
		const woken = board.changed("laptop", "p", new AbortController().signal);
		board.report(presence("live-1"));
		board.report(presence("live-2"));
		expect(await woken).toBe("live-2");
		expect(board.digest("laptop", "p")).toBe("live-2");
	});
});
