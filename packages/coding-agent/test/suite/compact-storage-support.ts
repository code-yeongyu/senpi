import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactStorageIo } from "../../src/modes/rpc/compact-storage-io.ts";

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
export function controlledIo(): { io: CompactStorageIo; hold(kind: "write" | "unlink"): IoHold } {
	const holds: Record<"write" | "unlink", IoHold[]> = { write: [], unlink: [] };
	const gates = new Map<IoHold, { entered: (path: string) => void; gate: Promise<void> }>();
	const pass = async (kind: "write" | "unlink", path: string) => {
		const hold = holds[kind].shift();
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
			readFile: (path) => readFile(path),
			async unlink(path) {
				await pass("unlink", path);
				await unlink(path);
			},
		},
		hold(kind) {
			const entered = Promise.withResolvers<string>();
			const gate = Promise.withResolvers<void>();
			const hold: IoHold = {
				entered: entered.promise,
				release: () => gate.resolve(),
				fail: (cause) => gate.reject(cause),
			};
			gates.set(hold, { entered: entered.resolve, gate: gate.promise });
			holds[kind].push(hold);
			return hold;
		},
	};
}

export async function spoolRoot(): Promise<{ dir: string; cleanup(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-compact-"));
	return { dir: join(root, "recovery", "epoch-1"), cleanup: () => rm(root, { recursive: true, force: true }) };
}
