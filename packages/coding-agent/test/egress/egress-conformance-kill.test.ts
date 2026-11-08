/**
 * egress-conformance KILL points of the device route (CK9): each durable write the route owns (W4', `ended`, W7, W14,
 * and the W6 admission it runs after; W4 is in device-proxy-egress.test.ts) is cut before and after it is durable on the
 * memory store, the brain restarts on the same store, and the call must execute exactly once with the hook count of 4.5.
 */
import type { DurableStore } from "@earendil-works/pi-agent-core/conformance";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { hostDouble, storeFixture } from "./device-proxy-doubles.ts";
import { fauxModel, handOf, handRoute, rig, tagRequest, transcript } from "./device-proxy-fixture.ts";

async function settle(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

async function cutAndRestart(
	at: "before" | "durable",
	nth: number,
	options: { readonly hook?: boolean; readonly arrange?: (cut: Awaited<ReturnType<typeof rig>>) => void } = {},
) {
	const fixture = await storeFixture();
	const faux = fauxModel();
	faux.reply("exactly once");
	const cutStore = await fixture.open({ nth, at });
	const cut = await rig({
		store: cutStore,
		respond: faux.respond,
		...(options.hook ? { requestHook: tagRequest } : {}),
	});
	options.arrange?.(cut);
	const outcome = await settle(await cut.egress.stream(faux.model, transcript(), {})).then(
		() => "completed",
		(error: unknown) => String(error),
	);
	const restarted = await rig({ store: await fixture.open(), respond: faux.respond, hands: cut.hands });
	return { cut, restarted, faux, outcome };
}

describe("egress-conformance: KILL points of the device route's writes (memory store)", () => {
	it("KILL-W6: a cut admission dials nothing; the re-admitted step executes once", async () => {
		for (const at of ["before", "durable"] as const) {
			const fixture = await storeFixture();
			const faux = fauxModel();
			faux.reply("admitted once");
			const cutStore: DurableStore = await fixture.open({ nth: 1, at });
			await expect(
				cutStore.commit(1, [{ op: "put", key: "session/step", data: "step-1" }], () => {}),
			).rejects.toThrow(/KILL/);
			const restarted = await rig({ store: await fixture.open(), respond: faux.respond });
			expect((await settle(await restarted.egress.stream(faux.model, transcript(), {}))).content).toEqual([
				{ type: "text", text: "admitted once" },
			]);
			expect(handOf(restarted).executions).toBe(1);
		}
	});

	it("KILL-W4': a cut `hooked` update reissues with hooks enabled (before) or disabled (after); one execution", async () => {
		for (const at of ["before", "durable"] as const) {
			const { restarted, faux, outcome } = await cutAndRestart(at, 2, {
				hook: true,
				arrange: (cut) => handOf(cut).fault({ kind: "hang-after-hooked" }),
			});
			expect(outcome).toMatch(/KILL commit 2/);
			const hand = handOf(restarted);
			const [lost] = hand.starts;
			if (lost) hand.forget(lost.callId);
			await settle(await restarted.egress.stream(faux.model, transcript(), {}));
			expect(hand.starts.map((start) => start.hooks)).toEqual(["enabled", at === "before" ? "enabled" : "disabled"]);
			expect(hand.hookRuns).toBe(at === "before" ? 2 : 1);
			expect(hand.executions).toBe(1);
		}
	});

	it("KILL-ended: a cut `ended` commit never pushes the terminal event; restart replays the hand's result", async () => {
		for (const at of ["before", "durable"] as const) {
			const { cut, restarted, faux, outcome } = await cutAndRestart(at, 2);
			expect(outcome).toMatch(/KILL commit 2/);
			expect(handOf(cut).acks).toEqual([]);
			const message = await settle(await restarted.egress.stream(faux.model, transcript(), {}));
			expect(message.content).toEqual([{ type: "text", text: "exactly once" }]);
			expect(handOf(restarted).executions).toBe(1);
		}
	});

	it("KILL-W7: a cut wait record dials nothing; after restart the step waits again and executes once", async () => {
		for (const at of ["before", "durable"] as const) {
			const fixture = await storeFixture();
			const faux = fauxModel();
			faux.reply("after the wait");
			const cutStore = await fixture.open({ nth: 1, at });
			const host = {
				...hostDouble(),
				onWait: async () =>
					cutStore.commit(1, [{ op: "put", key: "session/wait", data: "w" }], () => {}).then(() => {}),
			};
			const cut = await rig({ store: cutStore, respond: faux.respond, host });
			cut.route.decision = () => ({
				...handRoute(),
				servedNow: false,
				steer: "wait",
				waitFor: [{ kind: "device-online", deviceId: "laptop" }],
			});
			await expect(settle(await cut.egress.stream(faux.model, transcript(), {}))).rejects.toThrow(/KILL commit 1/);
			expect(handOf(cut).starts).toEqual([]);

			const restarted = await rig({ store: await fixture.open(), respond: faux.respond, hands: cut.hands });
			let online = false;
			restarted.route.decision = () =>
				online
					? handRoute()
					: {
							...handRoute(),
							servedNow: false,
							steer: "wait",
							waitFor: [{ kind: "device-online", deviceId: "laptop" }],
						};
			const waiting = restarted.conditions.nextWait();
			const stream = await restarted.egress.stream(faux.model, transcript(), {});
			await waiting;
			online = true;
			restarted.conditions.release();
			await settle(stream);
			expect(handOf(restarted).executions).toBe(1);
		}
	});

	it("KILL-W14: an abort is final only once step.cancelled is durable", async () => {
		for (const at of ["before", "durable"] as const) {
			const fixture = await storeFixture();
			const faux = fauxModel();
			faux.reply("resumed");
			const cut = await rig({ store: await fixture.open({ nth: 2, at }), respond: faux.respond });
			const hand = handOf(cut);
			hand.fault({ kind: "hang-after-events", events: 0 });
			const controller = new AbortController();
			const written = cut.commits.reached(1);
			const stream = await cut.egress.stream(faux.model, transcript(), { signal: controller.signal });
			await written;
			await hand.started(1);
			controller.abort();
			await expect(settle(stream)).rejects.toThrow("Request was aborted");

			const restarted = await rig({ store: await fixture.open(), respond: faux.respond, hands: cut.hands });
			const resumed = restarted.egress.stream(faux.model, transcript(), {});
			if (at === "before") {
				const [row] = await restarted.ledger.rowsForStep("step-1");
				await hand.finish(row?.callId ?? "");
				expect((await settle(await resumed)).content).toEqual([{ type: "text", text: "resumed" }]);
			} else {
				expect((await settle(await resumed)).stopReason).toBe("aborted");
			}
			expect(hand.starts).toHaveLength(1);
		}
	});
});
