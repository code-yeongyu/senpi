import type { RegisteredCase } from "../../conformance/registry.ts";
import { KILL_BATCH_DECLARATIONS } from "./kill-batch.ts";

const BATCH_CASES_IMPL = "packages/agent/src/execution/testing/batch-cases.ts";
const INTRO = "#5416";

const batchCase = (id: string, expected: string): RegisteredCase => ({
	id,
	impl: BATCH_CASES_IMPL,
	intro: INTRO,
	adapters: ["store", "executor"],
	expected,
});

export const BATCH_REGISTRY: readonly RegisteredCase[] = [
	batchCase(
		"BATCH-01",
		"the brain crashes after the manifest: the same execution ids are re-prepared; nothing had run",
	),
	batchCase(
		"BATCH-02",
		"the brain crashes after the prepares: prepare is re-sent, stored replies return, hooks never rerun",
	),
	batchCase(
		"BATCH-03",
		"the brain crashes inside a released wave: released calls get a re-sent release, unmarked ready calls are released, the next wave waits",
	),
	batchCase("BATCH-05", "an executor restart keeps prepared and released calls, and release proceeds"),
	batchCase("BATCH-06", "a lost prepared execution answers unknown_execution and is uncertain; siblings settle"),
	batchCase(
		"BATCH-07",
		"prepare runs in source order across executors; each release waits for its dependencies' final outcomes",
	),
	batchCase("BATCH-08", "a batch_abort reply ABORTs the batch: no later prepare, no body, abort re-sent on recovery"),
	batchCase("BATCH-09", "a blocked call is a per-call result; the other calls are released"),
	batchCase(
		"REPLAY-01",
		"an executor restart during preparation replays like today (X12): placeholder result, never rerun, a reissued call runs once",
	),
	batchCase(
		"REPLAY-02",
		"the same beside a prepared sibling: the sibling is aborted unrun, both replay with the placeholder",
	),
	...KILL_BATCH_DECLARATIONS.map(({ id, scenario, kill }): RegisteredCase => ({
		id,
		impl: "packages/agent/src/execution/testing/kill-batch.ts",
		intro: INTRO,
		adapters: ["store", "executor"],
		expected: `everywhere: kill the brain ${kill.at} its ${kill.label} write (${scenario}); recovery reaches the uncrashed outcomes with stable ids, each step run once`,
	})),
];
