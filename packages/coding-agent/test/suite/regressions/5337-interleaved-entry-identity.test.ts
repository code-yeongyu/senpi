import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { settledRig } from "./4272-settled-support.ts";

// senpi#5337, RULING-121: an entry's owning message is captured when its append is applied, keyed to that entry, so
// transcript batches applied before its `entry_appended` cannot drop the `owningMessageId` the compact copy carries.

afterEach(() => vi.unstubAllEnvs());

type Rig = Awaited<ReturnType<typeof settledRig>>;

function ownedAppend(rig: Rig, content: string) {
	const message = { role: "user" as const, content, timestamp: 1 };
	const start = { type: "message_start", message };
	rig.producer.observe(start);
	const owner = recoveryCarrier(start) ?? expect.unreachable("no owner minted");
	rig.lane.accept(start, owner);
	const id = rig.manager.appendOwnedMessage(message, { recoveryOwner: owner });
	rig.lane.applyTranscript(rig.manager.drainTranscript());
	return { messageId: owner.messageId, entry: rig.manager.getEntry(id) ?? expect.unreachable() };
}

/** Accepts the entry's `entry_appended`; returns the identity the writer stamps on a compact peer's copy of it. */
function entryAppended(rig: Rig, entry: object) {
	rig.lane.accept({ type: "entry_appended", entry }, undefined);
	return rig.lane.identities.of("entry_appended", rig.lane.acceptedSequence);
}

it("RULING-121 (#5337) two transcript batches between an append and its entry_appended keep its owningMessageId, equal to recovery's join row", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const first = ownedAppend(rig, "first");
		// Two other batches: a second message's owned append, then an unowned custom entry.
		const second = ownedAppend(rig, "second");
		rig.manager.appendCustomEntry("interleaved", { n: 1 });
		rig.lane.applyTranscript(rig.manager.drainTranscript());
		const live = entryAppended(rig, first.entry);
		expect(live, "the first entry keeps its owner").toEqual({ owningMessageId: first.messageId });
		expect(entryAppended(rig, second.entry)).toEqual({ owningMessageId: second.messageId });
		const { owners } = await rig.cut();
		expect(owners, "the live stamp is recovery's join row").toContainEqual({
			kind: "owner",
			messageId: first.messageId,
			entryId: first.entry.id,
		});
		expect(entryAppended(rig, first.entry), "a join is consumed by its entry_appended").toBeUndefined();
	} finally {
		await rig.close();
	}
});
