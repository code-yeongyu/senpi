import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { createSequentialCoordinator } from "../coordinator-sequential.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { batchHarness, batchPlan, resultOf } from "./batch-harness.ts";

/**
 * MULTI-FAIR-02 (Z2, S11): session A runs a long sequential batch on executor e1 and its first call is held inside its
 * body; session B's batch on the same executor runs to completion meanwhile, and A then continues in its own order.
 */
const longSequentialDoesNotStarve: CaseImplementation<BatchCaseAdapters> = async (adapters) => {
	const h = await batchHarness(adapters);
	const held = h.hold("a1", "body");
	const sessionA = createSequentialCoordinator(await h.brain(undefined, "brain-a"));
	const runA = sessionA.run(
		batchPlan("multi-fair-02-a", [
			["a1", "e1"],
			["a2", "e1"],
			["a3", "e1"],
		]),
	);
	await held.reached;
	const sessionB = await h.brain(undefined, "brain-b");
	const resultB = await sessionB.run(
		batchPlan("multi-fair-02-b", [
			["b1", "e1"],
			["b2", "e1"],
		]),
	);
	expectEqual(resultB.outcomes, [resultOf("b1"), resultOf("b2")], "B finishes while A's call is held");
	expectEqual(h.count("shim:a2"), 0, "A's next call waits for its own held call, not for B");
	held.open();
	expectEqual((await runA).outcomes, [resultOf("a1"), resultOf("a2"), resultOf("a3")], "A finishes in its order");
	const order = (step: string): number => h.trace.indexOf(step);
	if (
		!(
			order("done:b2") < order("done:a1") &&
			order("done:a1") < order("shim:a2") &&
			order("done:a2") < order("shim:a3")
		)
	)
		throw new Error(`MULTI-FAIR-02: unexpected order ${h.trace.join(",")}`);
};

export const MULTI_SEQ_CASES: ReadonlyMap<string, CaseImplementation<BatchCaseAdapters>> = new Map([
	["MULTI-FAIR-02", longSequentialDoesNotStarve],
]);
