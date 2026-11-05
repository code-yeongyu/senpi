// senpi#5916 (S35 follow-up): a loop-hook call is admitted only through the tool scope's epoch fence. A known call id is
// answered from the stored answer before the fence; a floorless epoch-bearing call and a call below the floor never run.
import { describe, expect, it } from "vitest";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { decodeLoopHookMessage, encodeLoopHookMessage } from "../../src/execution/loop-hook-host-protocol.ts";
import { createHandEpochFence } from "../../src/execution/remote-epoch.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

function handEnd() {
	const sent: unknown[] = [];
	let deliver: FrameHandler | undefined;
	const transport: Transport = {
		send: async (_lane, payload) => void sent.push(decodeLoopHookMessage(payload)),
		onFrame: (handler) => {
			deliver = handler;
		},
		inFlight: () => 0,
		close: () => {},
	};
	const call = (callId: string, epoch: number | undefined) =>
		deliver?.({
			lane: "hooks",
			payload: encodeLoopHookMessage({
				kind: "hook.call",
				callId,
				event: "before_agent_start",
				payload: { scope: { id: "s", root: "/w" } },
				...(epoch === undefined ? {} : { epoch }),
			}),
		});
	return { transport, sent, call };
}

async function hand() {
	const end = handEnd();
	const runs: string[] = [];
	const fence = createHandEpochFence({ ownerOf: () => "brain-b" });
	serveLoopHooks({
		transport: end.transport,
		lane: "hooks",
		fence,
		sender: "brain-b",
		run: async (event) => {
			runs.push(event);
			return { ran: runs.length };
		},
	});
	return { ...end, runs, fence };
}

const kinds = (sent: unknown[]) => sent.map((message) => (message as { kind: string }).kind);

describe("the loop-hook lane is fenced by the tool scope's floor (senpi#5916)", () => {
	it("refuses an epoch-bearing call while the scope has no floor: floor_missing, the hook never runs", async () => {
		const h = await hand();
		await h.call("c1", 1);
		expect(h.runs).toEqual([]);
		expect(h.sent.at(-1)).toMatchObject({ kind: "hook.failed", callId: "c1", error: "floor_missing" });
	});

	it("after the floor rises, refuses a call below it and runs one at it once", async () => {
		const h = await hand();
		await h.fence.raise("s", 1, "brain-b");
		await h.fence.raise("s", 2, "brain-b");
		await h.call("old", 1);
		await h.call("new", 2);
		expect(h.runs).toEqual(["before_agent_start"]);
		expect(h.sent).toContainEqual(expect.objectContaining({ kind: "hook.failed", callId: "old", error: "epoch_fenced" }));
		expect(h.sent).toContainEqual(expect.objectContaining({ kind: "hook.reply", callId: "new" }));
	});

	it("answers a known call id from its stored answer before the fence, so a re-send after a floor rise is not refused", async () => {
		const h = await hand();
		await h.fence.raise("s", 1, "brain-b");
		await h.call("c1", 1);
		await h.fence.raise("s", 2, "brain-b");
		await h.call("c1", 1);
		expect(h.runs).toEqual(["before_agent_start"]);
		expect(kinds(h.sent).filter((kind) => kind === "hook.reply")).toHaveLength(2);
	});

	it("a stale owner re-sending a known call id below the epoch it ran at is refused, not answered", async () => {
		const h = await hand();
		await h.fence.raise("s", 1, "brain-b");
		await h.fence.raise("s", 2, "brain-b");
		await h.call("c2", 2);
		await h.call("c2", 1);
		expect(h.runs).toEqual(["before_agent_start"]);
		expect(kinds(h.sent).filter((kind) => kind === "hook.reply")).toHaveLength(1);
		expect(h.sent.at(-1)).toMatchObject({ kind: "hook.failed", callId: "c2", error: "epoch_fenced" });
	});
});
