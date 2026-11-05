import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { MAX_PENDING_JOINS } from "../../../src/modes/rpc/compact-message-identity.ts";
import { settledRig } from "./4272-settled-support.ts";

// senpi#5337, RULING-122 review: an OWNED append whose join the settled store never recorded must still stamp its
// `entry_appended` with `ownerUnknown`, because a bare absence is normative "not owned".

afterEach(() => vi.unstubAllEnvs());

type Rig = Awaited<ReturnType<typeof settledRig>>;

function ownedAppend(rig: Rig, content: string, producer = rig.producer) {
	const message = { role: "user" as const, content, timestamp: 1 };
	const start = { type: "message_start", message };
	producer.observe(start);
	const owner = recoveryCarrier(start) ?? expect.unreachable("no owner minted");
	rig.lane.accept(start, owner);
	const id = rig.manager.appendOwnedMessage(message, { recoveryOwner: owner });
	rig.lane.applyTranscript(rig.manager.drainTranscript());
	return { owner, entry: rig.manager.getEntry(id) ?? expect.unreachable() };
}

function entryAppended(rig: Rig, entry: object, canonicalRefused = false) {
	rig.lane.accept({ type: "entry_appended", entry }, undefined, undefined, canonicalRefused);
	return rig.lane.identities.of("entry_appended", rig.lane.acceptedSequence);
}

async function withRig(body: (rig: Rig) => Promise<void> | void) {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		await body(rig);
	} finally {
		await rig.close();
	}
}

it("RULING-122 review (a) an owned append applied while the transcript is unavailable stamps ownerUnknown", () =>
	withRig((rig) => {
		rig.lane.applyTranscript([{ kind: "unavailable", reason: "transcript_ancestry_over_byte_limit" }]);
		const { entry } = ownedAppend(rig, "unavailable");
		expect(entryAppended(rig, entry), "no join was recorded, but the entry is owned").toEqual({ ownerUnknown: true });
		const unowned = rig.manager.appendCustomEntry("unowned", { n: 1 });
		rig.lane.applyTranscript(rig.manager.drainTranscript());
		expect(entryAppended(rig, rig.manager.getEntry(unowned) ?? expect.unreachable())).toBeUndefined();
	}));

it("RULING-122 review (b) an owned append whose join the settled store refuses stamps ownerUnknown", () =>
	withRig((rig) => {
		const { owner, entry: first } = ownedAppend(rig, "first");
		const message = { role: "user" as const, content: "again", timestamp: 1 };
		const again = rig.manager.appendOwnedMessage(message, { recoveryOwner: owner });
		rig.lane.applyTranscript(rig.manager.drainTranscript());
		expect(rig.diagnostics).toContain("conflicting_owner");
		expect(entryAppended(rig, first)).toEqual({ owningMessageId: owner.messageId });
		const refused = rig.manager.getEntry(again) ?? expect.unreachable();
		expect(entryAppended(rig, refused), "a refused join is not 'not owned'").toEqual({ ownerUnknown: true });
	}));

it("RULING-122 review (b) an owned append carrying a retired epoch's owner stamps ownerUnknown", () =>
	withRig((rig) => {
		const stale = rig.producer;
		rig.lane.bootstrap({ transcript: rig.manager.beginTranscriptJournal() });
		const { entry } = ownedAppend(rig, "stale", stale);
		expect(rig.diagnostics).toContain("retired_owner");
		expect(entryAppended(rig, entry)).toEqual({ ownerUnknown: true });
	}));

it("RULING-122 review (c) an unfolded entry_appended still carries its owner to compact peers", () =>
	withRig((rig) => {
		const { owner, entry } = ownedAppend(rig, "refused canonical");
		expect(entryAppended(rig, entry, true), "the delivered record still names its owner").toEqual({
			owningMessageId: owner.messageId,
		});
	}));

it("RULING-122 review (c) an unfolded entry_appended takes its join, so it never counts as evicted", () =>
	withRig((rig) => {
		const { entry } = ownedAppend(rig, "refused canonical");
		entryAppended(rig, entry, true);
		for (let n = 0; n < MAX_PENDING_JOINS; n++)
			rig.lane.identities.joined({ kind: "append", id: `e${n}`, type: "message", parentId: null }, `m${n}`);
		expect(rig.lane.storageStatus().ownerJoinsEvicted, "its join did not linger to the bound").toBe(0);
	}));
