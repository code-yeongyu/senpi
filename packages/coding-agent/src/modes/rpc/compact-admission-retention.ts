import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CompactAdmissionError } from "./compact-admission-error.ts";
import { ADMISSION_LIMITS } from "./compact-admission-storage.ts";
import type { Epoch } from "./compact-admission-types.ts";

/** RULING-113: a terminal row stays answerable as the most recent LRU entry; a live row is never retained. */
export function retainDone(epoch: Epoch, key: string): void {
	if (epoch.hot.has(key)) return;
	epoch.done.delete(key);
	epoch.done.add(key);
}

/** Evict least-recent terminal rows (file and reservation) until one more row fits; each leaves its digest. */
export async function reserveRow(epoch: Epoch, capacity: number, overflowed: () => void): Promise<boolean> {
	for (const key of epoch.done) {
		if (epoch.hot.size + epoch.done.size < capacity) return true;
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
