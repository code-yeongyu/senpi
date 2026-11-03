import { TOOL_RESULT_PLACEHOLDER } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { interruptedReplayText } from "../coordinator-plan.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { ExecutorKilledError } from "./batch-executor.ts";
import {
	type BatchHarness,
	BrainKilledError,
	batchHarness,
	batchPlan,
	expectRejects,
	resultOf,
} from "./batch-harness.ts";

type BatchCase = CaseImplementation<BatchCaseAdapters>;

function ranOnce(h: BatchHarness, ids: readonly string[], steps: readonly string[], what: string): void {
	for (const id of ids) for (const step of steps) expectEqual(h.count(`${step}:${id}`), 1, `${what}: ${step}:${id}`);
}

function before(h: BatchHarness, first: string, second: string, what: string): void {
	const a = h.trace.indexOf(first);
	const b = h.trace.indexOf(second);
	if (a < 0 || b < 0 || a > b) throw new Error(`${what}: expected ${first} before ${second} in ${h.trace.join(",")}`);
}

const crashAfterManifest: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-01", [
		["a", "e1"],
		["b", "e2"],
	]);
	await expectRejects((await h.brain({ label: "manifest", at: "after" })).run(plan), BrainKilledError, "kill");
	expectEqual(h.trace, [], "nothing has run after the manifest alone");
	const result = await (await h.brain()).run(plan);
	expectEqual(result, { decision: "RELEASE", outcomes: [resultOf("a"), resultOf("b")] }, "re-prepared and run");
	ranOnce(h, ["a", "b"], ["shim", "hook", "body"], "the same execution ids, each step once");
	expectEqual(await h.ledgerState("e1", "a"), "settled", "the endpoint row carries the manifest's execution id");
};

const crashAfterPrepares: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-02", [
		["a", "e1"],
		["b", "e2"],
	]);
	await expectRejects((await h.brain({ label: "decision", at: "before" })).run(plan), BrainKilledError, "kill");
	expectEqual(h.trace, ["shim:a", "hook:a", "shim:b", "hook:b"], "both prepared, no body before the decision");
	const result = await (await h.brain()).run(plan);
	expectEqual(result.outcomes, [resultOf("a"), resultOf("b")], "the stored prepare replies decide RELEASE");
	ranOnce(h, ["a", "b"], ["shim", "hook", "body"], "hooks never rerun");
};

const crashInsideFirstWave: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-03", [
		["a", "e1"],
		["b", "e2"],
		["c", "e1", "read", "sequential"],
	]);
	const bodyA = h.hold("a", "body");
	await expectRejects((await h.brain({ label: "release:b", at: "before" })).run(plan), BrainKilledError, "kill");
	await bodyA.reached;
	const settledB = h.written("outcome:b");
	const resumed = (await h.brain()).run(plan);
	const writes = await settledB;
	expectEqual(writes.includes("release:c"), false, "the next wave is not released while wave 0 is unsettled");
	bodyA.open();
	expectEqual((await resumed).outcomes, [resultOf("a"), resultOf("b"), resultOf("c")], "every call settles");
	ranOnce(h, ["a", "b", "c"], ["hook", "body"], "a re-sent release never reruns a body");
	before(h, "body:b", "done:a", "the unmarked wave-0 call is released beside the re-sent one");
	before(h, "done:a", "body:c", "wave 1 waits for a");
	before(h, "done:b", "body:c", "wave 1 waits for b");
};

const executorRestartKeepsPrepared: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-05", [
		["a", "e1"],
		["b", "e1", "read", "sequential"],
	]);
	const dispatchA = h.hold("a", "dispatch");
	const brain = await h.brain();
	const first = brain.run(plan);
	await dispatchA.reached;
	await h.restartExecutor("e1");
	await expectRejects(first, ExecutorKilledError, "the release in flight is lost with the executor");
	expectEqual(await h.ledgerState("e1", "a"), "released", "released survives the restart");
	expectEqual(await h.ledgerState("e1", "b"), "prepared", "prepared survives the restart");
	dispatchA.open();
	expectEqual((await brain.run(plan)).outcomes, [resultOf("a"), resultOf("b")], "release proceeds");
	ranOnce(h, ["a", "b"], ["hook", "body"], "nothing is prepared or run twice");
};

const lostPreparedExecution: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-06", [
		["a", "e1"],
		["b", "e2"],
	]);
	await expectRejects((await h.brain({ label: "decision", at: "after" })).run(plan), BrainKilledError, "kill");
	await h.loseExecutor("e1");
	const { outcomes } = await (await h.brain()).run(plan);
	const lost = { kind: "interrupted", reason: "unknown_execution", uncertain: true } as const;
	expectEqual(outcomes, [lost, resultOf("b")], "a lost prepared execution is uncertain; the sibling settles");
	expectEqual(h.count("body:a"), 0, "the lost call never runs");
	expectEqual(interruptedReplayText(lost), TOOL_RESULT_PLACEHOLDER, "it replays with today's placeholder");
};

const wavesAcrossExecutors: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-07", [
		["a", "e1"],
		["b", "e2"],
		["s", "e1", "read", "sequential"],
		["d", "e2"],
	]);
	const hookA = h.hold("a", "hook");
	const [bodyA, bodyB] = [h.hold("a", "body"), h.hold("b", "body")];
	const run = (await h.brain()).run(plan);
	await hookA.reached;
	expectEqual(h.count("shim:b"), 0, "b is prepared only after a's prepare reply");
	hookA.open();
	await Promise.all([bodyA.reached, bodyB.reached]);
	const settledB = h.written("outcome:b");
	bodyB.open();
	const writes = await settledB;
	expectEqual(writes.includes("release:s"), false, "the sequential call is not released while the wave runs");
	bodyA.open();
	expectEqual(
		(await run).outcomes,
		["a", "b", "s", "d"].map((id) => resultOf(id)),
		"every call settles",
	);
	for (const [first, second] of [
		["shim:a", "shim:b"],
		["shim:b", "shim:s"],
		["shim:s", "shim:d"],
	] as const)
		before(h, first, second, "prepare runs in source order across executors");
	for (const [first, second] of [
		["done:a", "body:s"],
		["done:b", "body:s"],
		["done:s", "body:d"],
	] as const)
		before(h, first, second, "a release waits for its dependencies' final outcomes");

	const chain = batchPlan("batch-07-blocked-link", [
		["s1", "e1", "read", "sequential"],
		["s2", "e2", "deny", "sequential"],
		["s3", "e1", "read", "sequential"],
		["p", "e2"],
	]);
	const last = h.written("outcome:p");
	const blocked = { kind: "blocked", result: "blocked: deny" } as const;
	expectEqual(
		(await (await h.brain()).run(chain)).outcomes,
		[resultOf("s1"), blocked, resultOf("s3"), resultOf("p")],
		"a blocked link settles as blocked; the chain runs",
	);
	const order = await last;
	for (const [finished, released] of [
		["outcome:s1", "release:s3"],
		["outcome:s3", "release:p"],
	] as const) {
		const [a, b] = [order.indexOf(finished), order.indexOf(released)];
		if (a < 0 || b < 0 || a > b)
			throw new Error(`a blocked link still waits on its own dependencies: ${finished} before ${released}`);
	}
};

const batchAbort: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-08", [
		["a", "e1"],
		["b", "e2", "stop"],
		["c", "e1"],
	]);
	await expectRejects((await h.brain({ label: "decision", at: "after" })).run(plan), BrainKilledError, "kill");
	const result = await (await h.brain()).run(plan);
	const notRun = { kind: "not_run", cause: "batch_abort" } as const;
	expectEqual(result, { decision: "ABORT", outcomes: [notRun, notRun, notRun] }, "ABORT ends every call");
	expectEqual(h.count("shim:c"), 0, "no call after the batch_abort reply is prepared");
	expectEqual(["body:a", "body:b"].map(h.count), [0, 0], "no body runs");
	expectEqual(await h.ledgerState("e1", "a"), "settled", "the re-sent abort ends the prepared call");
};

const blockedBesideReleased: BatchCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const plan = batchPlan("batch-09", [
		["a", "e1", "deny"],
		["b", "e2"],
		["c", "e1", "read", "sequential"],
	]);
	const result = await (await h.brain()).run(plan);
	const blocked = { kind: "blocked", result: "blocked: deny" } as const;
	expectEqual(result, { decision: "RELEASE", outcomes: [blocked, resultOf("b"), resultOf("c")] }, "others run");
	expectEqual(h.count("body:a"), 0, "a blocked call's body never runs");
	expectEqual(await h.ledgerState("e1", "a"), "settled", "the blocked call's endpoint is closed");
};

async function replayInterruptedPreparation(adapters: BatchCaseAdapters, withPreparedSibling: boolean) {
	const h = await batchHarness(adapters);
	const ids = withPreparedSibling ? ["a", "b"] : ["b"];
	const plan = batchPlan(
		`replay-${ids.length}`,
		ids.map((id) => [id, "e1"] as const),
	);
	const hookB = h.hold("b", "hook");
	const brain = await h.brain();
	const first = brain.run(plan);
	await hookB.reached;
	await h.restartExecutor("e1");
	await expectRejects(first, ExecutorKilledError, "the executor died during preparation");
	const { decision, outcomes } = await brain.run(plan);
	const interrupted = { kind: "interrupted", reason: "hand_restarted", uncertain: true } as const;
	const sibling = { kind: "not_run", cause: "interrupted_preparation" } as const;
	expectEqual(decision, "ABORT", "unreleased calls are aborted");
	expectEqual(outcomes, withPreparedSibling ? [sibling, interrupted] : [interrupted], "outcomes");
	expectEqual(
		outcomes.map(interruptedReplayText),
		ids.map(() => TOOL_RESULT_PLACEHOLDER),
		"today's placeholder",
	);
	ranOnce(h, ids, ["shim", "hook"], "preparation never runs again");
	expectEqual(
		ids.map((id) => h.count(`body:${id}`)),
		ids.map(() => 0),
		"no body runs",
	);
	const again = ids.map((id) => `${id}-again`);
	const reissued = await brain.run(
		batchPlan(
			`${plan.batchId}-again`,
			again.map((id) => [id, "e1"] as const),
		),
	);
	expectEqual(
		reissued.outcomes,
		again.map((id) => resultOf(id)),
		"a reissued call runs afresh",
	);
	ranOnce(h, again, ["shim", "hook", "body"], "exactly once");
}

export const BATCH_CASES: ReadonlyMap<string, BatchCase> = new Map([
	["BATCH-01", crashAfterManifest],
	["BATCH-02", crashAfterPrepares],
	["BATCH-03", crashInsideFirstWave],
	["BATCH-05", executorRestartKeepsPrepared],
	["BATCH-06", lostPreparedExecution],
	["BATCH-07", wavesAcrossExecutors],
	["BATCH-08", batchAbort],
	["BATCH-09", blockedBesideReleased],
	["REPLAY-01", (adapters) => replayInterruptedPreparation(adapters, false)],
	["REPLAY-02", (adapters) => replayInterruptedPreparation(adapters, true)],
]);
