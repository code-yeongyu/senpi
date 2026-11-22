import { dirname } from "node:path";
import { allocateCell, collectionCell, dropCell, scalarCell } from "./bench-cells.ts";
import { measure, measured, timed } from "./bench-measure.ts";
import type { Scenario } from "./bench-scenarios-latency.ts";

const MIB = 1024 * 1024;

export const gcAllocateDrop: Scenario = {
	name: "gc-allocate-drop",
	async run({ language, fresh, rep, session: retained }) {
		if (language === "js") {
			let onCollected: ((liveBytes: number) => void) | undefined;
			let idleCollections = 0;
			const kernel = new retained.JavaScriptKernel({
				sessionId: `bench-gc-${crypto.randomUUID()}`,
				cwd: dirname(retained.fixturePath),
				parallelPoolWidth: 1,
				memory: { gcWatermarkBytes: 32 * MIB, noticeBytes: 64 * MIB, ceilingBytes: 0 },
				onMemoryCollected: (liveBytes) => {
					if (onCollected) {
						idleCollections += 1;
						onCollected(liveBytes);
					}
				},
			});
			try {
				for (let index = 0; index < 5; index += 1) {
					const warm = await kernel.run({ cellId: `warm-${index}`, code: scalarCell.js, timeoutMs: 60_000 });
					if (!warm.ok) throw new Error(warm.error.message);
				}
				const { value, window } = await timed(async () => {
					const allocated = await kernel.run({
						cellId: "allocate",
						code: allocateCell.js,
						timeoutMs: 120_000,
					});
					if (!allocated.ok || !allocated.memory) throw new Error("GC allocation produced no memory report");
					const before = allocated.memory.liveBytes;
					const collected = Promise.withResolvers<number>();
					onCollected = (liveBytes) => {
						if (liveBytes < before * 0.5) collected.resolve(liveBytes);
					};
					const timer = setTimeout(() => collected.reject(new Error("no idle GC completion")), 60_000);
					try {
						const [dropped, after] = await Promise.all([
							kernel.run({ cellId: "drop", code: dropCell.js, timeoutMs: 120_000 }).then((result) => {
								if (!result.ok) throw new Error(result.error.message);
								return result;
							}),
							collected.promise,
						]);
						return {
							collections:
								[allocated, dropped].filter((result) => result.memory?.gcRan === true).length + idleCollections,
							liveBytesAllocated: before,
							liveBytesDropped: after,
							liveChangeBytes: after - before,
						};
					} finally {
						clearTimeout(timer);
						onCollected = undefined;
					}
				});
				return measured(window, 0, {
					observations: { ...value, gcWatermarkMiB: 32, observation: "idle-collection" },
				});
			} finally {
				await kernel.close();
			}
		}
		const session = await fresh({ gcWatermarkMb: 32, noticeMb: 64, ceilingMb: 0 });
		try {
			for (let index = 0; index < 5; index += 1) await session.cell(scalarCell[language]);
			const kernel = await session.kernel();
			return await measure(session, async () => {
				const allocated = await kernel.run({
					cellId: `bench-alloc-${rep}`,
					code: allocateCell[language],
					timeoutMs: 120_000,
				});
				const dropped = await kernel.run({
					cellId: `bench-drop-${rep}`,
					code: dropCell[language],
					timeoutMs: 120_000,
				});
				const collected = await kernel.run({
					cellId: `bench-collect-${rep}`,
					code: collectionCell[language],
					timeoutMs: 120_000,
				});
				for (const result of [allocated, dropped, collected]) {
					if (!result.ok) throw new Error(`gc-allocate-drop failed in ${language}: ${result.error.message}`);
				}
				const before = allocated.memory?.liveBytes;
				const after = collected.memory?.liveBytes;
				return {
					observations: {
						collections: [allocated, dropped, collected].filter((result) => result.memory?.gcRan === true).length,
						forcedCollections: 1,
						gcWatermarkMiB: 32,
						liveBytesAllocated: before ?? null,
						liveBytesDropped: after ?? null,
						liveChangeBytes: before === undefined || after === undefined ? null : after - before,
					},
				};
			});
		} finally {
			await session.dispose();
		}
	},
};
