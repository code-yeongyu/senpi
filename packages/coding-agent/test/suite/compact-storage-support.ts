import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactStorageIo } from "../../src/modes/rpc/compact-storage-io.ts";

let ordinal = 0;
/** Producer-side fixture numbering; the consumer never fills missing identity fields. */
export const startIdentity = (firstOrdinal = ordinal) => ({
	epoch: "fixture-producer",
	firstOrdinal,
	ordinal: ordinal++,
});
export const startBlock = (messageId: string, seed: string) => ({
	type: "block_start" as const,
	...startIdentity(),
	messageId,
	contentIndex: 0,
	kind: "text" as const,
	seed,
	coveredCodeUnits: 0,
});

export interface IoHold {
	/** Resolves with the path once the storage job reaches the held operation. */
	readonly entered: Promise<string>;
	release(): void;
	fail(cause: Error): void;
}

/**
 * Real filesystem I/O with deterministic hold points: each `hold(kind)` parks the next operation of
 * that kind until the test releases or fails it, so spill and reclamation schedules need no timers.
 */
export function controlledIo(): {
	io: CompactStorageIo;
	hold(kind: "write" | "read" | "unlink", match?: (path: string) => boolean): IoHold;
} {
	const holds: Record<"write" | "read" | "unlink", IoHold[]> = { write: [], read: [], unlink: [] };
	const gates = new Map<
		IoHold,
		{ entered: (path: string) => void; gate: Promise<void>; match: (path: string) => boolean }
	>();
	const pass = async (kind: "write" | "read" | "unlink", path: string) => {
		const index = holds[kind].findIndex((hold) => gates.get(hold)?.match(path));
		const hold = index < 0 ? undefined : holds[kind].splice(index, 1)[0];
		const gate = hold && gates.get(hold);
		if (!gate) return;
		gate.entered(path);
		await gate.gate;
	};
	return {
		io: {
			async writeFile(path, data) {
				await pass("write", path);
				await writeFile(path, data, { flag: "wx", mode: 0o600 });
			},
			async readFile(path) {
				await pass("read", path);
				return readFile(path);
			},
			async unlink(path) {
				await pass("unlink", path);
				await unlink(path);
			},
		},
		hold(kind, match = () => true) {
			const entered = Promise.withResolvers<string>();
			const gate = Promise.withResolvers<void>();
			const hold: IoHold = {
				entered: entered.promise,
				release: () => gate.resolve(),
				fail: (cause) => gate.reject(cause),
			};
			gates.set(hold, { entered: entered.resolve, gate: gate.promise, match });
			holds[kind].push(hold);
			return hold;
		},
	};
}

export async function spoolRoot(): Promise<{ dir: string; cleanup(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-compact-"));
	return { dir: join(root, "recovery", "epoch-1"), cleanup: () => rm(root, { recursive: true, force: true }) };
}
