import { afterEach, expect, it, vi } from "vitest";
import { type RecoveryCarrier, recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => vi.unstubAllEnvs());

// senpi#4272 carry item 9 (senpi#4460): a settled message keeps resident exactly the two id-sized facts the
// duplicate-end and conflicting-owner checks need (its join, its claimed entry); its end marker and terminal row go.
// A message in flight (ended and unjoined, or joined before its end) holds two keys of its own, never more.
it("item 9 resident settled keys stay at two per message across a long session in both join orders", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const join = (carrier: RecoveryCarrier, content: string) => {
			rig.manager.appendOwnedMessage({ role: "user", content, timestamp: 1 }, { recoveryOwner: carrier });
			rig.lane.applyTranscript(rig.manager.drainTranscript());
		};
		let inFlight = 0;
		const settledKeys = () => rig.lane.storageStatus().residentSettledKeys;
		for (let index = 0; index < 300; index++) {
			const content = `m${index}`;
			if (index % 2 === 0) {
				const { carrier } = rig.end("user", content);
				inFlight = Math.max(inFlight, settledKeys() - 2 * index);
				join(carrier, content);
			} else {
				const record = { type: "message_end", message: { role: "user", content, timestamp: 1 } };
				rig.producer.observe(record);
				const carrier = recoveryCarrier(record);
				if (!carrier) throw new Error("producer failed to mint");
				join(carrier, content);
				inFlight = Math.max(inFlight, settledKeys() - 2 * index);
				rig.lane.accept(record, carrier);
			}
			expect(settledKeys(), `settled message ${index} keeps its join and its entry`).toBe(2 * (index + 1));
		}
		expect(inFlight, "a message in flight holds only its own two keys").toBe(2);
		const unjoined = rig.end("user", "never persisted");
		expect(settledKeys()).toBe(602);
		rig.lane.accept({ type: "message_end", message: { role: "user", content: "again" } }, unjoined.carrier);
		expect(rig.diagnostics).toEqual(["duplicate_end"]);
		const cut = await rig.cut();
		expect(cut.owners).toHaveLength(300);
		expect(cut.settledMessages.map((row) => row.messageId)).toEqual([unjoined.carrier.messageId]);
	} finally {
		await rig.close();
	}
});
