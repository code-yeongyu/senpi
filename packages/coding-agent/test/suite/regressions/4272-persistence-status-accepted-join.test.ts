import { afterEach, expect, it, vi } from "vitest";
import { CompactLaneCurrent } from "../../../src/modes/rpc/compact-lane-current.ts";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function endOf(content: string) {
	return { type: "message_end", message: { role: "user", content, timestamp: 1 } };
}

// senpi#4460 LOW-2: a message_end carrying a durable entry settles compact persistence as appended only when the lane
// accepted that join; a rejected join (conflicting owner, replayed end) leaves the message's persistence alone.
it("a message_end whose durable entry another message owns does not mark the message appended", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const status = vi.spyOn(CompactLaneCurrent.prototype, "status");
	const rig = await settledRig();
	try {
		const epoch = rig.lane.recoveryEpoch;
		rig.manager.appendOwnedMessage(
			{ role: "user", content: "owned", timestamp: 1 },
			{ recoveryOwner: { messageId: "owner-a", epoch } },
		);
		const [append] = rig.manager.drainTranscript();
		if (append?.kind !== "append") throw new Error("no owned append");
		rig.lane.applyTranscript([append]);
		expect(status.mock.calls).toEqual([["owner-a", "appended"]]);
		rig.lane.accept(endOf("claim"), { messageId: "intruder", epoch, durableEntryId: append.id });
		expect(rig.diagnostics).toEqual(["conflicting_owner"]);
		expect(status.mock.calls, "a rejected join settles no persistence").toEqual([["owner-a", "appended"]]);
		rig.lane.accept(endOf("owned"), { messageId: "owner-a", epoch, durableEntryId: append.id });
		rig.lane.accept(endOf("owned"), { messageId: "owner-a", epoch, durableEntryId: append.id });
		expect(rig.diagnostics).toEqual(["conflicting_owner", "duplicate_end"]);
		expect(status.mock.calls, "an end of an already joined message adds nothing").toEqual([["owner-a", "appended"]]);
		rig.manager.appendCustomMessageEntry("notice", "existing", true);
		const [existing] = rig.manager.drainTranscript();
		if (existing?.kind !== "append") throw new Error("no custom append");
		rig.lane.applyTranscript([existing]);
		rig.lane.accept(endOf("existing"), { messageId: "owner-b", epoch, durableEntryId: existing.id });
		expect(rig.diagnostics).toEqual(["conflicting_owner", "duplicate_end"]);
		expect(status.mock.calls.at(-1), "an accepted join at the end marks the message appended").toEqual([
			"owner-b",
			"appended",
		]);
	} finally {
		await rig.close();
	}
});
