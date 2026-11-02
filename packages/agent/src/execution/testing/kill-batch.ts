import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { BatchResult } from "../coordinator-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import {
	type BrainKill,
	BrainKilledError,
	batchHarness,
	batchPlan,
	type CallSpec,
	expectRejects,
	resultOf,
} from "./batch-harness.ts";

type Scenario = {
	readonly name: string;
	readonly calls: readonly CallSpec[];
	readonly writes: readonly string[];
	readonly expected: BatchResult;
	readonly prepared: readonly string[];
	readonly bodies: number;
};

const notRun = { kind: "not_run", cause: "batch_abort" } as const;
const SCENARIOS: readonly Scenario[] = [
	{
		name: "a released wave then a sequential call",
		calls: [
			["a", "e1"],
			["b", "e2"],
			["c", "e1", "read", "sequential"],
		],
		writes: ["manifest", "prepare:a", "prepare:b", "prepare:c", "decision", "release:a", "release:b"].concat([
			"outcome:a",
			"outcome:b",
			"release:c",
			"outcome:c",
		]),
		expected: { decision: "RELEASE", outcomes: [resultOf("a"), resultOf("b"), resultOf("c")] },
		prepared: ["a", "b", "c"],
		bodies: 1,
	},
	{
		name: "a batch_abort reply",
		calls: [
			["a", "e1"],
			["b", "e2", "stop"],
			["c", "e1"],
		],
		writes: ["manifest", "prepare:a", "prepare:b", "decision", "outcome:a", "outcome:b", "outcome:c"],
		expected: { decision: "ABORT", outcomes: [notRun, notRun, notRun] },
		prepared: ["a", "b"],
		bodies: 0,
	},
];
const AT: readonly BrainKill["at"][] = ["before", "after"];

export interface KillBatchDeclaration {
	readonly id: string;
	readonly scenario: string;
	readonly kill: BrainKill;
	readonly placement: "everywhere";
}

const cases = SCENARIOS.flatMap((scenario, scenarioIndex) =>
	scenario.writes.flatMap((label, writeIndex) =>
		AT.map((at, atIndex) => {
			const number = SCENARIOS.slice(0, scenarioIndex).reduce((sum, s) => sum + s.writes.length, 0) + writeIndex + 1;
			const id = `KILL-BATCH-${String(number).padStart(2, "0")}-${atIndex + 1}`;
			const kill: BrainKill = { label, at };
			const run: CaseImplementation<BatchCaseAdapters> = async (adapters) => {
				const h = await batchHarness(adapters);
				const plan = batchPlan(id.toLowerCase(), scenario.calls);
				await expectRejects((await h.brain(kill)).run(plan), BrainKilledError, `${at} ${label}`);
				expectEqual(
					await (await h.brain()).run(plan),
					scenario.expected,
					"recovery reaches the uncrashed outcomes",
				);
				for (const [executionId, executor] of scenario.calls) {
					const preparedOnce = scenario.prepared.includes(executionId) ? 1 : 0;
					for (const step of ["shim", "hook"])
						expectEqual(h.count(`${step}:${executionId}`), preparedOnce, `${step}:${executionId} once at most`);
					expectEqual(h.count(`body:${executionId}`), preparedOnce * scenario.bodies, `body:${executionId}`);
					if (preparedOnce === 1) expectEqual(await h.ledgerState(executor, executionId), "settled", "stable ids");
				}
			};
			return { id, scenario: scenario.name, kill, placement: "everywhere" as const, run };
		}),
	),
);

export const KILL_BATCH_DECLARATIONS: readonly KillBatchDeclaration[] = cases.map(({ run: _run, ...entry }) => entry);
export const KILL_BATCH_CASES: ReadonlyMap<string, CaseImplementation<BatchCaseAdapters>> = new Map(
	cases.map(({ id, run }) => [id, run]),
);
