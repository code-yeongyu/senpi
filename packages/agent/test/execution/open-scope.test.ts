// senpi#5932 (S35 follow-up): a session opens a scope's epoch floor before its first tool call, so a loop hook that runs
// first never reaches a floorless hand. The open settles only on the hand's floor_ack at the session's epoch.
import { describe, expect, it } from "vitest";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { decodeLoopHookMessage, encodeLoopHookMessage } from "../../src/execution/loop-hook-host-protocol.ts";
import type { HandEpochFence } from "../../src/execution/remote-epoch.ts";
import { openEpochRig } from "../../src/execution/testing/epoch-harness.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";
import { call } from "../../src/execution/testing/hand-harness.ts";
import { handAdapters } from "./hand-adapters.ts";

function hookLane(fence: HandEpochFence, sender: string, runs: string[]) {
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
	serveLoopHooks({
		transport,
		lane: "hooks",
		fence,
		sender,
		run: async (event) => {
			runs.push(event);
			return {};
		},
	});
	const call = async (callId: string, epoch: number): Promise<void> =>
		deliver?.({
			lane: "hooks",
			payload: encodeLoopHookMessage({
				kind: "hook.call",
				callId,
				event: `before_agent_start:${callId}`,
				payload: { scope: { id: "s", root: "/w" } },
				epoch,
			}),
		});
	return { sent, call };
}

describe("openScope (senpi#5932)", () => {
	it("opens the floor at the session's epoch before any tool call; a late call at the earlier epoch is fenced", async () => {
		const rig = await openEpochRig(handAdapters("linux"), {
			brains: [
				{ name: "brain-a", epoch: 1 },
				{ name: "brain-b", epoch: 2 },
			],
		});
		rig.setOwner("s", "brain-a");
		expect(await rig.settle(rig.openScope("brain-a", "s"), "brain-a opened the scope")).toEqual({ kind: "open" });
		rig.setOwner("s", "brain-b");
		let floorAtOpen: unknown = "unread";
		const opened = rig.openScope("brain-b", "s").then(async (result) => {
			floorAtOpen = await rig.floor("s");
			return result;
		});
		const result = await rig.settle(opened, "brain-b opened the scope");

		expect(result).toEqual({ kind: "open" });
		expect(floorAtOpen).toMatchObject({ epoch: 2 });
		expect(rig.bodies).toEqual([]);

		const late = await rig.settle(rig.execute("brain-a", "s", [call("late")]), "the old owner's call settled");
		expect(rig.bodies).toEqual([]);
		expect(JSON.stringify(late.messages)).toContain("refused");
	});

	it("a hook call at the opened epoch runs, and one at the earlier epoch from the old owner is refused", async () => {
		const rig = await openEpochRig(handAdapters("linux"), {
			brains: [
				{ name: "brain-a", epoch: 1 },
				{ name: "brain-b", epoch: 2 },
			],
		});
		rig.setOwner("s", "brain-a");
		await rig.settle(rig.openScope("brain-a", "s"), "brain-a opened the scope");
		rig.setOwner("s", "brain-b");
		let floorAtOpen: number | undefined;
		const opened = rig.openScope("brain-b", "s").then((result) => {
			floorAtOpen = rig.fence().floorOf("s");
			return result;
		});
		expect(await rig.settle(opened, "brain-b opened the scope")).toEqual({ kind: "open" });
		expect(floorAtOpen).toBe(2);

		const runs: string[] = [];
		const owner = hookLane(rig.fence(), "brain-b", runs);
		const old = hookLane(rig.fence(), "brain-a", runs);
		await owner.call("c-new", 2);
		await old.call("c-old", 1);

		expect(runs).toEqual(["before_agent_start:c-new"]);
		expect(old.sent.at(-1)).toEqual({
			kind: "hook.refused",
			callId: "c-old",
			reason: "epoch_fenced",
			epoch: 1,
			floor: 2,
		});
	});

	it("never hangs: an abort ends the wait when the hand does not answer", async () => {
		const rig = await openEpochRig(handAdapters("linux"), { brains: [{ name: "brain-b", epoch: 2 }] });
		rig.setOwner("s", "brain-b");
		const controller = new AbortController();
		const opened = rig.openScope("brain-b", "s", controller.signal);
		controller.abort();
		expect(await opened).toEqual({ kind: "refused", reason: "aborted" });
	});
});
