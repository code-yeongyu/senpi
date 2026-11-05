import { CompactAdmissionError } from "./compact-admission-error.ts";
import { readAdmissionRow, writeAdmissionRow } from "./compact-admission-storage.ts";
import type { Answer, Epoch, Produced } from "./compact-admission-types.ts";

/**
 * Settle a produced admission inside the epoch's serial lane: persist its terminal row, then activate it.
 * `cancelled` is true when the answer was stored without activation, so the caller must release the producer.
 */
export async function settleProducedAdmission(
	epoch: Epoch,
	key: string,
	fingerprint: string,
	produced: Produced,
	serial: (action: () => Promise<boolean>) => Promise<boolean>,
): Promise<{ value: Answer; cancelled: boolean }> {
	let value = produced.answer;
	const cancelled = await serial(async () => {
		const row = await readAdmissionRow(epoch, key);
		const retired = epoch.ended || row?.state === "cancelled";
		const persist = async () => {
			const answer = JSON.stringify(value);
			if (Buffer.byteLength(answer) > 65_536) throw new CompactAdmissionError("storage_unavailable");
			await writeAdmissionRow(epoch, key, {
				state: retired ? "cancelled" : "complete",
				fingerprint,
				answer,
			});
		};
		value = produced.refusal?.() ?? value;
		await persist();
		// Overflow during the durable write is a terminal, replayable refusal, not a fresh attempt.
		const refused = produced.refusal?.();
		if (refused && JSON.stringify(refused) !== JSON.stringify(value)) {
			value = refused;
			await persist();
		}
		if (retired || epoch.ended || refused) return true;
		// RULING-93: durable terminal row FIRST, synchronous activation SECOND. A crash
		// between them ends this connection, which retires its subscription and pending buffer.
		try {
			produced.activate?.();
		} catch (cause) {
			process.stderr.write(
				`senpi rpc admission activation failed; releasing subscription: ${cause instanceof Error ? cause.message : String(cause)}\n`,
			);
			epoch.failures.set(key, { state: "failed", fingerprint, failure: "storage_unavailable" });
			throw new CompactAdmissionError("storage_unavailable");
		}
		return false;
	});
	return { value, cancelled };
}
