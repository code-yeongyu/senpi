import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, rig, transcript } from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

describe("device-proxy egress: reissues are bounded and callback-stream reissues ask first (CK9; design 4.5)", () => {
	it("bounds the lost-call cycle: one reissue at once, one after a 5 s backoff, then the user's choice", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		const r = await rig({ store, respond: faux.respond });
		const hand = handOf(r);
		hand.amnesiac();
		const controller = new AbortController();
		const runaway = hand.started(10).then(() => "runaway reissue cycle");
		const backoff = r.clock.nextSleep(5_000);
		const stream = await r.egress.stream(faux.model, transcript(), { signal: controller.signal });
		try {
			expect(await Promise.race([backoff, runaway])).toBe(5_000);
			expect(hand.starts).toHaveLength(2);
			const choice = r.conditions.nextWait();
			r.clock.advance(5_000);
			expect(await Promise.race([choice, runaway])).toEqual([{ kind: "user-choice", choiceId: "step-1:4" }]);
			expect(hand.starts.map((start) => start.call)).toEqual(
				[1, 2, 3].map((attempt) => ({ kind: "step", stepId: "step-1", attempt })),
			);
			const rows = await r.ledger.rowsForStep("step-1");
			expect(rows.map((row) => row.state)).toEqual(["superseded", "superseded", "superseded"]);
			expect(r.host.waits.map((wait) => wait.reason)).toEqual(["result-pending", "result-pending"]);
		} finally {
			controller.abort();
		}
		await expect(drain(stream)).rejects.toThrow("Request was aborted");
	});

	it("asks the user before redialing a callback-stream step whose attempt ended in an error", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("redialed after the choice");
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		first.route.capability = "callback-stream";
		const hand = handOf(first);
		hand.fault({ kind: "error", code: "unavailable", retryable: true });
		expect((await drain(await first.egress.stream(faux.model, transcript(), {}))).stopReason).toBe("error");

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		again.route.capability = "callback-stream";
		const waiting = again.conditions.nextWait();
		const stream = await again.egress.stream(faux.model, transcript(), {});
		const redialed = hand.started(2).then(() => "redialed without the user's choice");
		expect(await Promise.race([waiting, redialed])).toEqual([{ kind: "user-choice", choiceId: "step-1:2" }]);
		expect(hand.starts).toHaveLength(1);
		again.conditions.release();
		expect((await drain(stream)).content).toEqual([{ type: "text", text: "redialed after the choice" }]);
		expect(hand.starts.map((start) => start.call.kind === "step" && start.call.attempt)).toEqual([1, 2]);
	});
});
