// senpi#6051: every hand case must pass on a store whose writes reach the caller only after I/O, as a Durable
// Object SQLite commit does (it confirms durability with `await storage.sync()`). Each write here takes three I/O
// turns, so a case that waits a fixed span of transport time instead of for its condition fails too.
import { describe, it } from "vitest";
import type { DurableStore } from "../../src/durable/store.ts";
import { FAULT_HAND_CASES } from "../../src/execution/testing/fault-hand-cases.ts";
import type { HandCaseAdapters } from "../../src/execution/testing/hand-harness.ts";
import { KILL_HAND_CASES } from "../../src/execution/testing/kill-hand.ts";
import { MULTI_HAND_CASES } from "../../src/execution/testing/multi-hand-cases.ts";
import { handAdapters } from "./hand-adapters.ts";

const IO_TURNS_PER_WRITE = 3;
const ioTurn = async (): Promise<void> => {
	for (let turn = 0; turn < IO_TURNS_PER_WRITE; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function asyncDurable(store: DurableStore): DurableStore {
	return {
		...store,
		claim: async (expected, next) => {
			await store.claim(expected, next);
			await ioTurn();
		},
		commit: async (epoch, writes, adopt) => {
			const result = await store.commit(epoch, writes, adopt);
			await ioTurn();
			return result;
		},
		importSnapshot: async (epoch, snapshot) => {
			await store.importSnapshot(epoch, snapshot);
			await ioTurn();
		},
	};
}

function asyncDurableAdapters(): HandCaseAdapters {
	const adapters = handAdapters("linux");
	return {
		...adapters,
		store: {
			createMedium: () => adapters.store.createMedium(),
			open: async (medium, options) => asyncDurable(await adapters.store.open(medium, options)),
		},
	};
}

const cases = new Map([...KILL_HAND_CASES, ...MULTI_HAND_CASES, ...FAULT_HAND_CASES]);

describe("hand conformance on a store whose writes settle after an I/O turn", () => {
	for (const [id, run] of cases) {
		it(id, async () => {
			await run(asyncDurableAdapters());
		});
	}
});
