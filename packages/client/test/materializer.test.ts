import { it } from "vitest";
import { MemoryMaterializerAdapter } from "../src/materializer-memory.ts";
import { materializerConformance, type MaterializerHarness } from "../src/materializer-test-kit.ts";

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
