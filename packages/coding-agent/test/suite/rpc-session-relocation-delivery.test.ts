/**
 * senpi#5801: how many microtasks the event sink takes to deliver `host_request` must not change how a refusal reaches
 * the requester. A client that leaves while the record is still being written (an idle sink delivers it synchronously)
 * is ordered exactly like one that leaves one or many hops later: every waiter on the request is registered before the
 * record can be delivered, so the refusal and the teardown the leave starts are queued in the same order every time.
 */
import { describe, expect, it } from "vitest";
import type { RelocationChannel } from "../../src/modes/rpc/session-relocation-channel.ts";
import { RpcSessionRelocation } from "../../src/modes/rpc/session-relocation.ts";

const DESKTOP = "desktop";

/** Runs `step` after `hops` microtasks; 0 runs it synchronously, inside the `send` that delivers the record. */
function afterHops(hops: number, step: () => void): void {
	if (hops === 0) step();
	else queueMicrotask(() => afterHops(hops - 1, step));
}

function relocationOn(channel: RelocationChannel): RpcSessionRelocation {
	return new RpcSessionRelocation({
		session: {
			sessionFile: "/session.jsonl",
			subscribe: () => () => {},
			isStreaming: false,
			currentAbortSource: undefined,
			sendCustomMessage: async () => {},
			agent: { state: { messages: [], pendingToolCalls: new Set<string>() } },
		} as never,
		pendingPrompts: () => [],
		channel,
	});
}

async function leaveDuringDelivery(hops: number): Promise<{ order: string[]; delivered: number }> {
	const order: string[] = [];
	let delivered = 0;
	let teardown: Promise<void> = Promise.resolve();
	let relocation: RpcSessionRelocation | undefined;
	const channel: RelocationChannel = {
		offerer: () => DESKTOP,
		current: () => DESKTOP,
		send: (_connection, record) => {
			if ((record as { type?: string }).type !== "host_request") return;
			delivered += 1;
			afterHops(hops, () => {
				relocation?.connectionDetached(DESKTOP);
				// What a close does next, in the same stack as the leave: its teardown, one await per step.
				teardown = (async () => {
					for (const step of [1, 2, 3]) {
						await Promise.resolve();
						order.push(`teardown:${step}`);
					}
				})();
			});
		},
	};
	relocation = relocationOn(channel);
	const answered = relocation
		.request({ target: "Studio", reason: "heavy build" })
		.then((result) => order.push(`answer:${result.status}:${"reason" in result ? result.reason : ""}`));
	await answered;
	await teardown;
	relocation.dispose();
	return { order, delivered };
}

describe("relocation request delivery (senpi#5801)", () => {
	it("orders a refusal the same whether the client leaves zero, one or many sink hops into the delivery", async () => {
		// Given: the same request and leave, with the sink taking 0, 1 and 8 microtasks to hand the record over.
		const runs = await Promise.all([0, 1, 8].map(async (hops) => ({ hops, ...(await leaveDuringDelivery(hops)) })));

		// Then: the record went out once each time, the requester got the typed refusal, and the order never moved.
		for (const run of runs) {
			expect(run.delivered).toBe(1);
			expect(run.order).toContain("answer:refused:app_disconnected");
		}
		expect(runs.map((run) => run.order)).toEqual(runs.map(() => runs[2]?.order));
	});

	it("refuses the request at once when writing the record throws, instead of throwing past it", async () => {
		// Given: a channel whose write throws synchronously, as a failing sink or an in-process client's handler can.
		let writes = 0;
		const relocation = relocationOn({
			offerer: () => DESKTOP,
			current: () => DESKTOP,
			send: () => {
				writes += 1;
				throw new Error("sink write failed");
			},
		});

		// When: the agent asks to move, twice.
		const first = await relocation.request({ target: "Studio", reason: "heavy build" });
		const second = await relocation.request({ target: "Studio", reason: "again" });

		// Then: each request was written once and refused with the write's failure, never left waiting for an answer.
		const refusedSend = {
			status: "refused",
			reason: "send_failed",
			detail: expect.stringContaining("sink write failed"),
		};
		expect(first).toEqual(refusedSend);
		expect(second).toEqual(refusedSend);
		expect(writes).toBe(2);
		relocation.dispose();
	});
});
