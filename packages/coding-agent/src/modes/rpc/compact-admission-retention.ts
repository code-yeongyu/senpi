import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CompactAdmissionError } from "./compact-admission-error.ts";
import { ADMISSION_LIMITS } from "./compact-admission-storage.ts";
import type { Epoch } from "./compact-admission-types.ts";

/** RULING-113: a terminal row stays answerable as the most recent LRU entry; a live row is never retained. */
export function retainDone(epoch: Epoch, key: string, admissionId: string): void {
	if (epoch.hot.has(key)) return;
	epoch.done.delete(key);
	epoch.done.set(key, admissionId);
}

/**
 * Evict least-recent terminal rows (file and reservation) until one more row fits; each leaves its digest. A row
 * whose admission still routes a stream is skipped (#5274: `reset_stream` reads it), yet still counts, so rows on
 * disk never exceed `capacity` and a fresh attempt is refused only when every row is live.
 */
export async function reserveRow(
	epoch: Epoch,
	capacity: number,
	routed: (admissionId: string) => boolean,
	overflowed: () => void,
): Promise<boolean> {
	for (const [key, admissionId] of epoch.done) {
		if (epoch.hot.size + epoch.done.size < capacity) return true;
		if (routed(admissionId)) continue;
		try {
			await rm(join(await epoch.directory, key), { force: true });
		} catch {
			throw new CompactAdmissionError("storage_unavailable");
		}
		epoch.done.delete(key);
		epoch.failures.delete(key);
		epoch.retired.add(key);
		for (const oldest of epoch.retired) {
			if (epoch.retired.size <= ADMISSION_LIMITS.retired) break;
			epoch.retired.delete(oldest);
			overflowed();
		}
	}
	return epoch.hot.size + epoch.done.size < capacity;
}
