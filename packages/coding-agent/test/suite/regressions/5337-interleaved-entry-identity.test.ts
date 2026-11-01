import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { MAX_EVICTED_JOINS, MAX_PENDING_JOINS, MessageIdentities } from "../../../src/modes/rpc/compact-message-identity.ts";
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

const append = (n: number) => ({ kind: "append" as const, id: `e${n}`, type: "message", parentId: null });

/** The identity an entry's `entry_appended` would be stamped with, taken from `identities`. */
function stampOf(identities: MessageIdentities, n: number) {
	identities.hold("entry_appended", n, { entry: { id: `e${n}` } }, undefined);
	return identities.of("entry_appended", n);
}

it("RULING-122 (#5337) a join evicted past the bound stamps ownerUnknown, never a bare absence", () => {
	const identities = new MessageIdentities();
	for (let n = 0; n <= MAX_PENDING_JOINS; n++) identities.joined(append(n), `m${n}`);
	expect(stampOf(identities, 0), "the oldest join went over the bound").toEqual({ ownerUnknown: true });
	expect(stampOf(identities, 1)).toEqual({ owningMessageId: "m1" });
	expect(stampOf(identities, MAX_PENDING_JOINS)).toEqual({ owningMessageId: `m${MAX_PENDING_JOINS}` });
	expect(identities.status()).toEqual({ ownerJoinsEvicted: 1, ownerJoinsOverflowed: 0 });
});

it("RULING-122 (#5337) once the evicted ring overflows, every unmatched entry of the epoch stamps ownerUnknown", () => {
	const identities = new MessageIdentities();
	const writes = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		const joins = MAX_PENDING_JOINS + MAX_EVICTED_JOINS + 2;
		for (let n = 0; n < joins; n++) identities.joined(append(n), `m${n}`);
		expect(stampOf(identities, 0), "evicted out of the ring too").toEqual({ ownerUnknown: true });
		expect(stampOf(identities, joins + 5), "never joined, but the engine cannot vouch").toEqual({ ownerUnknown: true });
		expect(stampOf(identities, joins - 1)).toEqual({ owningMessageId: `m${joins - 1}` });
		expect(identities.status()).toEqual({ ownerJoinsEvicted: MAX_EVICTED_JOINS + 2, ownerJoinsOverflowed: 2 });
		const lines = writes.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("owner join"));
		expect(lines, "one stderr line per epoch, at the first overflow").toHaveLength(1);
	} finally {
		writes.mockRestore();
	}
});

it("RULING-122 (#5337) without eviction an owned entry carries owningMessageId and an unowned one carries neither", () => {
	const identities = new MessageIdentities();
	identities.joined(append(1), "m1");
	expect(stampOf(identities, 1)).toEqual({ owningMessageId: "m1" });
	expect(stampOf(identities, 2), "not message-owned, and the engine can vouch").toBeUndefined();
	expect(identities.status()).toEqual({ ownerJoinsEvicted: 0, ownerJoinsOverflowed: 0 });
});

it("RULING-122 (#5337) an epoch reset clears the evicted ring and the overflow, keeping the counters", () => {
	const identities = new MessageIdentities();
	const writes = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		for (let n = 0; n < MAX_PENDING_JOINS + MAX_EVICTED_JOINS + 1; n++) identities.joined(append(n), `m${n}`);
		identities.reset();
		expect(stampOf(identities, MAX_PENDING_JOINS), "its ring entry went with the epoch").toBeUndefined();
		expect(stampOf(identities, 0), "no overflow carried into the new epoch").toBeUndefined();
		expect(identities.status()).toEqual({ ownerJoinsEvicted: MAX_EVICTED_JOINS + 1, ownerJoinsOverflowed: 1 });
	} finally {
		writes.mockRestore();
	}
});

it("RULING-121 (#5337) a join from an ended epoch never stamps a record of the next one", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const first = ownedAppend(rig, "first");
		rig.lane.bootstrap({ transcript: rig.manager.beginTranscriptJournal() });
		expect(entryAppended(rig, first.entry)).toBeUndefined();
	} finally {
		await rig.close();
	}
});
