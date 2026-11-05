// senpi#5932 (S35 follow-up): a session opens a scope's epoch floor before its first tool call, so a loop hook that runs
// first never reaches a floorless hand. The open settles only on the hand's floor_ack at the session's epoch.
import { describe, expect, it } from "vitest";
import { openEpochRig } from "../../src/execution/testing/epoch-harness.ts";
import { call } from "../../src/execution/testing/hand-harness.ts";
import { handAdapters } from "./hand-adapters.ts";

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

	it("never hangs: an abort ends the wait when the hand does not answer", async () => {
		const rig = await openEpochRig(handAdapters("linux"), { brains: [{ name: "brain-b", epoch: 2 }] });
		rig.setOwner("s", "brain-b");
		const controller = new AbortController();
		const opened = rig.openScope("brain-b", "s", controller.signal);
		controller.abort();
		expect(await opened).toEqual({ kind: "refused", reason: "aborted" });
	});
});
