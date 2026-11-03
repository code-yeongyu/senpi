import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { createSequentialCoordinator } from "../coordinator-sequential.ts";
import type { CallOutcome } from "../coordinator-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { BrainKilledError, batchHarness, batchPlan, expectRejects, resultOf } from "./batch-harness.ts";

type SeqCase = CaseImplementation<BatchCaseAdapters>;

const steps = (id: string): string[] => [`shim:${id}`, `hook:${id}`, `body:${id}`, `done:${id}`];
const notRun: CallOutcome = { kind: "not_run", cause: "batch_abort" };

/**
 * SEQ-01 (S11): `toolExecution: "sequential"` keeps today's interleaving on the coordinator: each call is its own
 * one-call batch, prepared and run to its outcome before the next is prepared, across executors. A crash inside a call
 * resumes from the durable batches and reruns nothing; a blocked call is a per-call result and the next call runs; a
 * stopped preparation ends the run, and the calls after it are never prepared.
 */
const interleave: SeqCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("seq-01", [
		["a", "e1"],
		["b", "e2"],
		["x", "e1", "deny"],
		["c", "e1"],
	]);
	const sequential = createSequentialCoordinator(await h.brain());
	const result = await sequential.run(plan);
	const blocked: CallOutcome = { kind: "blocked", result: "blocked: deny" };
	expectEqual(result.outcomes, [resultOf("a"), resultOf("b"), blocked, resultOf("c")], "every call settles");
	expectEqual(
		h.trace,
		[...steps("a"), ...steps("b"), "shim:x", "hook:x", ...steps("c")],
		"prepare and run interleave per call, a blocked call does not stop the next",
	);
	expectEqual(await sequential.run(plan), result, "a finished run returns its stored outcomes");
	expectEqual(h.trace.length, 14, "and runs nothing again");

	const crash = await batchHarness(adapters);
	const crashPlan = batchPlan("seq-01-crash", [
		["a", "e1"],
		["b", "e2"],
		["c", "e1"],
	]);
	const dying = createSequentialCoordinator(await crash.brain({ label: "release:b", at: "after" }));
	await expectRejects(dying.run(crashPlan), BrainKilledError, "kill");
	expectEqual(crash.trace, [...steps("a"), "shim:b", "hook:b"], "the crashed brain never prepared c");
	const resumed = await createSequentialCoordinator(await crash.brain()).run(crashPlan);
	expectEqual(resumed.outcomes, [resultOf("a"), resultOf("b"), resultOf("c")], "recovery reaches every outcome");
	expectEqual(crash.trace, [...steps("a"), ...steps("b"), ...steps("c")], "each step once, in call order");

	const stop = await batchHarness(adapters);
	const stopPlan = batchPlan("seq-01-stop", [
		["a", "e1"],
		["s", "e2", "stop"],
		["c", "e1"],
	]);
	const stopped = await createSequentialCoordinator(await stop.brain()).run(stopPlan);
	expectEqual(stopped, { decision: "ABORT", outcomes: [resultOf("a"), notRun, notRun] }, "a stop ends the run");
	expectEqual(stop.trace, [...steps("a"), "shim:s", "hook:s"], "the call after a stop is never prepared");
	const replayed = await createSequentialCoordinator(await stop.brain()).run(stopPlan);
	expectEqual(replayed, stopped, "recovery after a stop prepares nothing new");
	expectEqual(stop.trace.length, 6, "and runs nothing again");
};

export const SEQ_CASES: ReadonlyMap<string, SeqCase> = new Map([["SEQ-01", interleave]]);
