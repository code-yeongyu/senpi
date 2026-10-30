import {
	type MaterializerAdapter,
	type MaterializerIdentity,
	type MaterializerUnit,
	type MaterializerSnapshot,
	MaterializerConsumer,
	MaterializerRefusal,
} from "./materializer.ts";

export { MemoryMaterializerAdapter } from "./materializer-memory.ts";

/** Desktop D11 supplies its SQL harness here; scenarios are imported, never copied.
 * Snapshot must read from outside the open transaction. Restart must reopen only committed state.
 */
export interface MaterializerHarness {
	readonly adapter: MaterializerAdapter<string>;
	snapshot(key: MaterializerIdentity): Promise<MaterializerSnapshot>;
	failApplyAt(index: number | undefined): void;
	crashBeforeCommit(): void;
	holdBeforeCommit(): { readonly entered: Promise<void>; release(): void };
	restart(): Promise<MaterializerAdapter<string>>;
	dispose(): Promise<void>;
}
export interface MaterializerConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}
type Factory = () => Promise<MaterializerHarness>;
const key = { sessionId: "session", sessionEpoch: "epoch", generation: 1 };
const unit = (sequence: number, identity = key): MaterializerUnit<string> => ({
	...identity,
	kind: "unit",
	sequence,
	controls: ["seed", "clear"],
	record: `record-${sequence}`,
});
function equal(actual: unknown, expected: unknown): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(`materializer conformance: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function rejected(run: () => Promise<unknown>, code?: string): Promise<void> {
	try {
		await run();
	} catch (cause) {
		if (code && (!(cause instanceof MaterializerRefusal) || cause.code !== code)) throw cause;
		return;
	}
	throw new Error("materializer conformance: expected rejection");
}

/** Runtime-neutral test kit: register each returned run with any runner, unchanged for every adapter. */
export function materializerConformance(create: Factory): readonly MaterializerConformanceCase[] {
	const cases: readonly [string, (h: MaterializerHarness) => Promise<void>][] = [
		[
			"R95.3 effects and frontier are invisible until one atomic commit",
			async (h) => {
				await h.adapter.reset(key);
				const tx = await h.adapter.begin(key);
				await tx.apply(unit(7));
				equal(await h.snapshot(key), { frontier: 0, effects: [] });
				equal(await tx.commit(7), "applied");
				equal(await h.snapshot(key), { frontier: 7, effects: ["seed", "clear", "record-7"] });
			},
		],
		[
			"R95.1 replay and lower sequences skip without begin",
			async (h) => {
				let begins = 0;
				const consumer = new MaterializerConsumer({
					reset: (k) => h.adapter.reset(k),
					frontier: (k) => h.adapter.frontier(k),
					begin: (k) => {
						begins++;
						return h.adapter.begin(k);
					},
				});
				equal(await consumer.accept(unit(7)), "applied");
				equal(await consumer.accept(unit(7)), "duplicate");
				equal(await consumer.accept(unit(2)), "duplicate");
				equal(begins, 1);
				equal((await h.snapshot(key)).effects, ["seed", "clear", "record-7"]);
			},
		],
		[
			"R95.2 single flight refuses another begin instead of queueing",
			async (h) => {
				await h.adapter.reset(key);
				const tx = await h.adapter.begin(key);
				await rejected(() => h.adapter.begin(key), "in_flight");
				await tx.abort();
				const next = await h.adapter.begin(key);
				await next.abort();
			},
		],
		[
			"R95.4 explicit abort releases ownership and leaves no effects",
			async (h) => {
				await h.adapter.reset(key);
				const tx = await h.adapter.begin(key);
				await tx.apply(unit(3));
				await tx.abort();
				await tx.abort();
				equal(await h.snapshot(key), { frontier: 0, effects: [] });
				equal(await new MaterializerConsumer(h.adapter).accept(unit(3)), "applied");
			},
		],
		[
			"R95.4 a throw midway through apply aborts the whole unit",
			async (h) => {
				h.failApplyAt(1);
				const consumer = new MaterializerConsumer(h.adapter);
				await rejected(() => consumer.accept(unit(3)));
				equal(await h.snapshot(key), { frontier: 0, effects: [] });
				h.failApplyAt(undefined);
				equal(await consumer.accept(unit(3)), "applied");
			},
		],
		[
			"R95.5 crash after apply before commit preserves the last durable frontier and replay",
			async (h) => {
				const consumer = new MaterializerConsumer(h.adapter);
				await consumer.accept(unit(2));
				h.crashBeforeCommit();
				await rejected(() => consumer.accept(unit(5)));
				const restarted = new MaterializerConsumer(await h.restart());
				equal(await h.snapshot(key), { frontier: 2, effects: ["seed", "clear", "record-2"] });
				equal(await restarted.accept(unit(5)), "applied");
				equal(await restarted.accept(unit(5)), "duplicate");
				equal(await h.snapshot(key), {
					frontier: 5,
					effects: ["seed", "clear", "record-2", "seed", "clear", "record-5"],
				});
			},
		],
		[
			"R95.6 commit accepts gaps and deduplicates equal or lower frontiers",
			async (h) => {
				const consumer = new MaterializerConsumer(h.adapter);
				await consumer.accept(unit(7));
				for (const sequence of [7, 2]) {
					const tx = await h.adapter.begin(key);
					await tx.apply(unit(9));
					equal(await tx.commit(sequence), "duplicate");
					equal((await h.snapshot(key)).frontier, 7);
				}
				equal(await consumer.accept(unit(20)), "applied");
			},
		],
		[
			"R95.7 generation change aborts in-flight work and starts a fresh frontier",
			async (h) => {
				await h.adapter.reset(key);
				const old = await h.adapter.begin(key);
				await old.apply(unit(7));
				const next = { ...key, generation: 2 };
				await h.adapter.reset(next);
				await rejected(() => old.commit(7), "aborted");
				equal(await h.snapshot(key), { frontier: 0, effects: [] });
				equal(await h.snapshot(next), { frontier: 0, effects: [] });
				equal(await new MaterializerConsumer(h.adapter).accept(unit(1, next)), "applied");
				await rejected(() => h.adapter.reset(key), "stale_generation");
			},
		],
		[
			"R95.7 committed effects and frontier are isolated across generations",
			async (h) => {
				const consumer = new MaterializerConsumer(h.adapter);
				equal(await consumer.accept(unit(7)), "applied");
				equal(await h.snapshot(key), { frontier: 7, effects: ["seed", "clear", "record-7"] });
				const next = { ...key, generation: 2 };
				await consumer.reset(next);
				equal(await h.snapshot(next), { frontier: 0, effects: [] });
				equal(await consumer.accept(unit(1, next)), "applied");
				equal(await h.snapshot(next), { frontier: 1, effects: ["seed", "clear", "record-1"] });
			},
		],
		[
			"R95.1 independent sessions have independent frontiers and flights",
			async (h) => {
				const other = { ...key, sessionId: "other" };
				await h.adapter.reset(key);
				await h.adapter.reset(other);
				const first = await h.adapter.begin(key);
				const second = await h.adapter.begin(other);
				await first.apply(unit(8));
				await second.apply(unit(2, other));
				await first.commit(8);
				await second.commit(2);
				equal((await h.snapshot(key)).frontier, 8);
				equal((await h.snapshot(other)).frontier, 2);
			},
		],
		[
			"R66 a stray control at an already committed sequence is a typed refusal",
			async (h) => {
				const consumer = new MaterializerConsumer(h.adapter);
				await consumer.accept(unit(3));
				await rejected(() => consumer.accept({ ...key, kind: "control", sequence: 3 }), "stray_control");
				equal((await h.snapshot(key)).effects, ["seed", "clear", "record-3"]);
			},
		],
		[
			"R95.2 two consumers share single-flight ownership while commit is held",
			async (h) => {
				const gate = h.holdBeforeCommit();
				const first = new MaterializerConsumer(h.adapter).accept(unit(1));
				try {
					await gate.entered;
					await rejected(() => new MaterializerConsumer(h.adapter).accept(unit(2)), "in_flight");
					equal(await h.snapshot(key), { frontier: 0, effects: [] });
				} finally {
					gate.release();
				}
				equal(await first, "applied");
			},
		],
	];
	return cases.map(([name, run]) => ({
		name,
		run: async () => {
			const harness = await create();
			try {
				await run(harness);
			} finally {
				await harness.dispose();
			}
		},
	}));
}
