import { expect, it } from "vitest";
import { recoveryCarrier, SessionRecoveryIdentity } from "../../../src/core/session-recovery-identity.ts";
import { settledRig } from "./4272-settled-support.ts";

const userStart = (content: string) => ({
	type: "message_start" as const,
	message: { role: "user" as const, content, timestamp: 1 },
});

// senpi#4272 S03b-3: a canonical fold the reducer rejects never leaves a partial or stale current state, and never
// blocks the legacy record of the same unit: the epoch's compact component becomes unavailable, typed for readers.
it("a rejected canonical fold makes the epoch's compact state unavailable while legacy acceptance continues", async () => {
	const rig = await settledRig();
	try {
		const first = userStart("kept");
		rig.producer.observe(first);
		const carrier = recoveryCarrier(first);
		if (!carrier) throw new Error("producer failed to mint");
		rig.lane.accept(first, carrier, { record: first, carrier, ordinal: 0, firstOrdinal: 0 });
		const before = rig.lane.freeze();
		expect((await rig.lane.readCurrent(before)).messages).toMatchObject([{ message: { content: "kept" } }]);
		const foreign = userStart("foreign epoch");
		new SessionRecoveryIdentity("not-the-registry-nonce").observe(foreign);
		const other = recoveryCarrier(foreign);
		if (!other) throw new Error("producer failed to mint");
		const ref = rig.lane.accept(foreign, other, { record: foreign, carrier: other, ordinal: 1, firstOrdinal: 1 });
		expect(ref?.sequence).toBe(2);
		const after = rig.lane.freeze();
		expect(after.current).toBeUndefined();
		await expect(rig.lane.readCurrent(after)).rejects.toMatchObject({ reason: "unavailable" });
		await expect(rig.lane.readCurrent(before)).rejects.toMatchObject({ reason: "retired" });
		rig.lane.release(before);
		rig.lane.release(after);
	} finally {
		await rig.close();
	}
});
