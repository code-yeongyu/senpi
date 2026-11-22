import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { DeviceProxyEgress } from "../../src/core/egress/device-proxy-ports.ts";
import { closeCallWrites } from "../../src/core/egress/ledger.ts";
import { REQUEST_CHUNK_BYTES, requestPrefix } from "../../src/core/egress/ledger-schema.ts";
import { gatedStore, storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, rig, tagRequest, transcript } from "./device-proxy-fixture.ts";

/** Lets every queued microtask run, so whatever the egress would push without awaiting the gated write is pushed. */
const drainMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function run(egress: DeviceProxyEgress, ...args: Parameters<DeviceProxyEgress["stream"]>) {
	const stream = await egress.stream(...args);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

describe("device-proxy egress: one admitted step on the device route (CK9; design 4.3-4.5)", () => {
	it("passes the hand's events through and sends the claim plus only the admitted wire request", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("hello from the laptop");
		const r = await rig({ store, respond: faux.respond });
		const loopOptions: SimpleStreamOptions & { readonly commitStep: () => Promise<void> } = {
			apiKey: "brain-key",
			headers: { authorization: "Bearer brain" },
			signal: new AbortController().signal,
			sessionId: "affinity-1",
			maxTokens: 512,
			commitStep: async () => {},
		};
		const { events, message } = await run(r.egress, faux.model, transcript(), loopOptions);

		const hand = handOf(r);
		const [start] = hand.starts;
		expect(message.content).toEqual([{ type: "text", text: "hello from the laptop" }]);
		expect(events.at(-1)?.type).toBe("done");
		expect(start?.claim).toEqual(await r.claimSource());
		expect(start?.request).toEqual({ context: transcript(), options: { sessionId: "affinity-1", maxTokens: 512 } });
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(JSON.parse(await r.ledger.readRequest(row)).options).toEqual({ sessionId: "affinity-1", maxTokens: 512 });
		expect(start?.call).toEqual({ kind: "step", stepId: "step-1", attempt: 1 });
		expect(start?.expectedSourceDigest).toBe("digest-head");
		expect(start?.hooks).toBe("enabled");
		expect(hand.acks).toEqual([start?.callId]);
	});

	it("commits the ended row with the whole result before the terminal event is pushed", async () => {
		const gated = gatedStore(await (await storeFixture()).open(), 2);
		const faux = fauxModel();
		faux.reply("committed first");
		const r = await rig({ store: gated.store, respond: faux.respond });
		const stream = await r.egress.stream(faux.model, transcript(), {});
		const seen: string[] = [];
		const consumed = (async () => {
			for await (const event of stream) seen.push(event.type);
		})();
		await gated.reached;
		await drainMicrotasks();
		expect([...seen, ...stream.queue.map((event) => event.type)]).not.toContain("done");
		gated.release();
		await consumed;
		const [row] = await r.ledger.rowsForStep("step-1");
		expect(seen.at(-1)).toBe("done");
		expect(row?.state).toBe("ended");
		expect(row?.result?.kind).toBe("message");
		expect(handOf(r).acks).toHaveLength(1);
	});

	it("stores `hooked` (post-hook request, hooksApplied) before any event reaches the stream", async () => {
		const gated = gatedStore(await (await storeFixture()).open(), 2);
		const faux = fauxModel();
		faux.reply("hooked answer");
		const r = await rig({ store: gated.store, respond: faux.respond, requestHook: tagRequest });
		const stream = await r.egress.stream(faux.model, transcript(), {});
		const seen: string[] = [];
		const consumed = (async () => {
			for await (const event of stream) seen.push(event.type);
		})();
		await gated.reached;
		await drainMicrotasks();
		expect([...seen, ...stream.queue]).toEqual([]);
		gated.release();
		await consumed;
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no W4 row");
		expect(row.hooksApplied).toBe(true);
		expect(await r.ledger.readRequest(row)).toContain("[hooked]");
		expect(seen.at(-1)).toBe("done");
		expect(handOf(r).hookRuns).toBe(1);
	});

	it("keeps the admitted request in 96 KiB chunks until the close writes delete them (16 MiB round trip)", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("big answer");
		const r = await rig({ store, respond: faux.respond });
		const big = transcript("\u00e9".repeat(8 * 1024 * 1024));
		await run(r.egress, faux.model, big, {});
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		const stored = await r.ledger.readRequest(row);
		expect(JSON.parse(stored).context).toEqual(big);
		expect(row.requestChunks).toBe(Math.ceil(new TextEncoder().encode(stored).length / REQUEST_CHUNK_BYTES));
		expect(row.requestChunks).toBeGreaterThan(160);

		await store.commit(1, closeCallWrites(row), () => {});
		const [closed] = await r.ledger.rowsForStep("step-1");
		expect(closed?.state).toBe("closed");
		expect(await store.scanDocuments(requestPrefix(row.callId))).toEqual([]);
	});

	it("dials nothing when the W4 write is cut, before or after it is durable (KILL-W4)", async () => {
		for (const at of ["before", "durable"] as const) {
			const fixture = await storeFixture();
			const faux = fauxModel();
			faux.reply("after restart");
			const cut = await rig({ store: await fixture.open({ nth: 1, at }), respond: faux.respond });
			await expect((await cut.egress.stream(faux.model, transcript(), {})).result()).rejects.toThrow(
				/KILL commit 1/,
			);
			expect(handOf(cut).starts).toHaveLength(0);

			const restarted = await rig({ store: await fixture.open(), respond: faux.respond, hands: cut.hands });
			const { message } = await run(restarted.egress, faux.model, transcript(), {});
			const hand = handOf(restarted);
			expect(message.content).toEqual([{ type: "text", text: "after restart" }]);
			expect(hand.executions).toBe(1);
			expect(hand.starts.map((start) => start.call)).toEqual([
				{ kind: "step", stepId: "step-1", attempt: at === "before" ? 1 : 2 },
			]);
		}
	});
});
