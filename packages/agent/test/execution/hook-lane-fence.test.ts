// senpi#5916 (S35 follow-up): a loop-hook call is admitted only through the tool scope's epoch fence. A known call id is
// answered from its record before the fence, but only to the sender that first presented it or the scope's owner; a
// floorless epoch-bearing call and a call below the floor never run, and a refusal is never recorded as an answer.
import { describe, expect, it } from "vitest";
import { type LoopHookRecord, serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { decodeLoopHookMessage, encodeLoopHookMessage } from "../../src/execution/loop-hook-host-protocol.ts";
import { createHandEpochFence, type HandEpochFence } from "../../src/execution/remote-epoch.ts";
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

interface HandSetup {
	readonly sender?: string;
	readonly owner?: { current: string };
	readonly fence?: HandEpochFence;
	readonly records?: Map<string, LoopHookRecord>;
	readonly instance?: string;
	readonly runs?: string[];
	readonly hold?: boolean;
}

function hand(setup: HandSetup = {}) {
	const end = handEnd();
	const runs = setup.runs ?? [];
	const owner = setup.owner ?? { current: "brain-b" };
	const fence = setup.fence ?? createHandEpochFence({ ownerOf: () => owner.current });
	let markRunning: () => void = () => {};
	const running = new Promise<void>((resolve) => {
		markRunning = resolve;
	});
	serveLoopHooks({
		transport: end.transport,
		lane: "hooks",
		fence,
		ownerOf: () => owner.current,
		sender: setup.sender ?? "brain-b",
		...(setup.records === undefined ? {} : { records: setup.records }),
		...(setup.instance === undefined ? {} : { instance: setup.instance }),
		run: (event) => {
			runs.push(event);
			markRunning();
			return setup.hold === true ? new Promise(() => {}) : Promise.resolve({ ran: runs.length });
		},
	});
	return { ...end, runs, fence, owner, running };
}

const kinds = (sent: unknown[]) => sent.map((message) => (message as { kind: string }).kind);

describe("the loop-hook lane is fenced by the tool scope's floor (senpi#5916)", () => {
	it("refuses an epoch-bearing call while the scope has no floor: floor_missing without a floor, the hook never runs", async () => {
		const h = hand();
		await h.call("c1", 1);
		expect(h.runs).toEqual([]);
		expect(h.sent.at(-1)).toEqual({ kind: "hook.refused", callId: "c1", reason: "floor_missing", epoch: 1 });
	});

	it("after the floor rises, refuses a call below it (echoing its epoch and the floor) and runs one at it once", async () => {
		const h = hand();
		await h.fence.raise("s", 1, "brain-b");
		await h.fence.raise("s", 2, "brain-b");
		await h.call("old", 1);
		await h.call("new", 2);
		expect(h.runs).toEqual(["before_agent_start"]);
		expect(h.sent).toContainEqual({
			kind: "hook.refused",
			callId: "old",
			reason: "epoch_fenced",
			epoch: 1,
			floor: 2,
		});
		expect(h.sent).toContainEqual(expect.objectContaining({ kind: "hook.reply", callId: "new" }));
	});

	it("never records a refusal: the same id re-issued at the floor runs once", async () => {
		const h = hand();
		await h.fence.raise("s", 1, "brain-b");
		await h.fence.raise("s", 2, "brain-b");
		await h.call("c1", 1);
		await h.call("c1", 2);
		expect(h.runs).toEqual(["before_agent_start"]);
		expect(kinds(h.sent)).toEqual(["hook.hello", "hook.refused", "hook.started", "hook.reply"]);
	});

	it("replays a known id to its own sender before the fence, so a re-send after a floor rise is not refused", async () => {
		const h = hand();
		await h.fence.raise("s", 1, "brain-b");
		await h.call("c1", 1);
		await h.fence.raise("s", 2, "brain-b");
		await h.call("c1", 1);
		expect(h.runs).toEqual(["before_agent_start"]);
		expect(kinds(h.sent).filter((kind) => kind === "hook.reply")).toHaveLength(2);
	});

	it("a different sender presenting a known id at a stale epoch is refused by the fence, never replayed", async () => {
		const records = new Map<string, LoopHookRecord>();
		const owner = { current: "brain-a" };
		const fence = createHandEpochFence({ ownerOf: () => owner.current });
		const a = hand({ sender: "brain-a", owner, fence, records });
		await fence.raise("s", 1, "brain-a");
		await a.call("c1", 1);
		owner.current = "brain-b";
		await fence.raise("s", 2, "brain-b");
		owner.current = "brain-c";
		const stale = hand({ sender: "brain-b", owner, fence, records, runs: a.runs });
		await stale.call("c1", 1);
		expect(a.runs).toEqual(["before_agent_start"]);
		expect(stale.sent.at(-1)).toEqual({
			kind: "hook.refused",
			callId: "c1",
			reason: "epoch_fenced",
			epoch: 1,
			floor: 2,
		});
	});

	it("a known id from a non-matching sender above the floor answers callId_taken: never run, never replayed", async () => {
		const records = new Map<string, LoopHookRecord>();
		const owner = { current: "brain-a" };
		const fence = createHandEpochFence({ ownerOf: () => owner.current });
		const a = hand({ sender: "brain-a", owner, fence, records });
		await fence.raise("s", 1, "brain-a");
		await a.call("c1", 1);
		const other = hand({ sender: "brain-x", owner, fence, records, runs: a.runs });
		await other.call("c1", 2);
		expect(a.runs).toEqual(["before_agent_start"]);
		expect(other.sent.at(-1)).toEqual({
			kind: "hook.refused",
			callId: "c1",
			reason: "callId_taken",
			epoch: 2,
			floor: 1,
		});
	});

	it("the scope's current owner gets a known id's answer even when another sender presented it first", async () => {
		const records = new Map<string, LoopHookRecord>();
		const owner = { current: "brain-a" };
		const fence = createHandEpochFence({ ownerOf: () => owner.current });
		const a = hand({ sender: "brain-a", owner, fence, records });
		await fence.raise("s", 1, "brain-a");
		await a.call("c1", 1);
		owner.current = "brain-b";
		await fence.raise("s", 2, "brain-b");
		const b = hand({ sender: "brain-b", owner, fence, records, runs: a.runs });
		await b.call("c1", 2);
		expect(a.runs).toEqual(["before_agent_start"]);
		expect(b.sent.at(-1)).toMatchObject({ kind: "hook.reply", callId: "c1" });
	});

	it("answers hook.restarted only for a started record whose starter is another process", async () => {
		const records = new Map<string, LoopHookRecord>();
		const first = hand({ records, instance: "p1", hold: true });
		await first.fence.raise("s", 1, "brain-b");
		void first.call("c1", 1);
		await first.running;
		await first.call("c1", 1);
		expect(kinds(first.sent)).toEqual(["hook.hello", "hook.started"]);

		const second = hand({ records, instance: "p2", fence: first.fence, runs: first.runs });
		await second.call("c1", 1);
		expect(first.runs).toEqual(["before_agent_start"]);
		expect(second.sent.at(-1)).toEqual({ kind: "hook.restarted", callId: "c1", instance: "p2" });
	});
});
