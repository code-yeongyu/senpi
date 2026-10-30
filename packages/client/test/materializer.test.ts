import { expect, it } from "vitest";
import {
	MemoryMaterializerAdapter,
	materializerConformance,
	type MaterializerHarness,
} from "../src/materializer-test-kit.ts";
import { MaterializerRefusal, type MaterializerAdapter, type MaterializerIdentity } from "../src/materializer.ts";

async function referenceHarness(): Promise<MaterializerHarness> {
	let adapter = new MemoryMaterializerAdapter<string>();
	return {
		get adapter() {
			return adapter;
		},
		snapshot: async (key) => adapter.snapshot(key),
		failApplyAt(index) {
			adapter.beforeEffect = (_effect, at) => {
				if (at === index) throw new Error("injected apply failure");
			};
		},
		crashBeforeCommit() {
			adapter.beforeCommit = () => {
				adapter = adapter.restart();
				throw new Error("injected precommit crash");
			};
		},
		holdBeforeCommit() {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			adapter.beforeCommit = async () => {
				entered.resolve();
				await release.promise;
			};
			return { entered: entered.promise, release: () => release.resolve() };
		},
		restart: async () => {
			adapter = adapter.restart();
			return adapter;
		},
		dispose: async () => {},
	};
}

for (const scenario of materializerConformance(referenceHarness)) it(scenario.name, scenario.run, 10_000);

// Deliberately broken storage key: every generation shares one session's committed state.
async function sessionKeyedHarness(): Promise<MaterializerHarness> {
	const h = await referenceHarness();
	const generations = new Map<string, number>();
	const stored = (key: MaterializerIdentity) => ({ ...key, generation: 1 });
	const adapter: MaterializerAdapter<string> = {
		reset: async (key) => {
			const id = JSON.stringify([key.sessionId, key.sessionEpoch]);
			const previous = generations.get(id);
			if (previous !== undefined && key.generation < previous) throw new MaterializerRefusal("stale_generation");
			if (previous !== undefined && key.generation !== previous) await h.restart();
			generations.set(id, key.generation);
			await h.adapter.reset(stored(key));
		},
		frontier: (key) => h.adapter.frontier(stored(key)),
		begin: async (key) => {
			const tx = await h.adapter.begin(stored(key));
			return { ...tx, apply: (unit) => tx.apply({ ...unit, generation: 1 }) };
		},
	};
	return {
		...h,
		adapter,
		snapshot: (key) => h.snapshot(stored(key)),
		restart: async () => {
			await h.restart();
			return adapter;
		},
	};
}

it("the exported kit rejects session-keyed frontiers and effects across generations", async () => {
	const outcomes = await Promise.allSettled(
		materializerConformance(sessionKeyedHarness).map((scenario) => scenario.run()),
	);
	expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
});
