import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { type NestedAdmissionControl, nestedChildId } from "../nested.ts";
import type { NestedAdmission, NestedParent, NestedRequest } from "../nested-types.ts";
import { NESTED_LIFETIME_MS } from "../nested-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { batchHarness } from "./batch-harness.ts";

type NestCase = CaseImplementation<BatchCaseAdapters>;

/** The harness clock starts at 101; the parent was admitted then with a 60 s lease and a budget of 10. */
const NEST_ADMITTED_AT = 101;
const LEASE_MS = 60_000;

export const nestParent: NestedParent = {
	executionId: "p",
	generation: 1,
	executor: "e1",
	scope: "scope",
	admittedAt: NEST_ADMITTED_AT,
	leaseUntil: NEST_ADMITTED_AT + LEASE_MS,
	budget: 10,
	capabilities: { preparation: ["model"], body: ["e2"] },
};

export const nestRequest = (over: Partial<NestedRequest> = {}): NestedRequest => ({
	sender: "e1",
	parent: "p",
	parentGeneration: 1,
	scope: "scope",
	childRequestId: "c1",
	target: "model",
	cost: 1,
	...over,
});

export const admitted = (childRequestId: string, target: string, replayed: boolean): NestedAdmission => ({
	kind: "admitted",
	child: { issuer: "brain", executionId: nestedChildId("p", childRequestId), generation: 1 },
	target,
	replayed,
});

export const refusedWith = (reason: string) => ({ kind: "refused", reason });

export async function openedParent(adapters: BatchCaseAdapters) {
	const h = await batchHarness(adapters);
	const nested = await h.nested();
	await nested.open(nestParent);
	return { h, nested };
}

export const debited = async (nested: NestedAdmissionControl): Promise<number | undefined> =>
	(await nested.read("p"))?.debited;

/** NEST-01: a request from another hand naming a live parent, or naming a parent the brain does not hold, is refused. */
const wrongHand: NestCase = async (adapters) => {
	const { nested } = await openedParent(adapters);
	expectEqual(await nested.admit(nestRequest({ sender: "e2" })), refusedWith("not_parent_executor"), "another hand");
	expectEqual(await nested.admit(nestRequest({ parent: "forged" })), refusedWith("unknown_parent"), "forged parent");
	expectEqual(await debited(nested), 0, "nothing debited");
	expectEqual(await nested.admit(nestRequest()), admitted("c1", "model", false), "the parent's executor is admitted");
};

/** NEST-02: a replayed request returns the same child, also after a brain restart, and is debited once. */
const replay: NestCase = async (adapters) => {
	const { h, nested } = await openedParent(adapters);
	expectEqual(await nested.admit(nestRequest()), admitted("c1", "model", false), "first admission");
	expectEqual(await nested.admit(nestRequest()), admitted("c1", "model", true), "a replay, same child");
	const restarted = await h.nested();
	expectEqual(await restarted.admit(nestRequest()), admitted("c1", "model", true), "a replay after a restart");
	expectEqual(await debited(restarted), 1, "debited once");
	expectEqual(
		await restarted.admit(nestRequest({ target: "e2" })),
		refusedWith("conflicting_request"),
		"the same child request id for another call",
	);
	expectEqual(await restarted.open({ ...nestParent, executionId: "p/x" }), { kind: "opened" }, "a parent named p/x");
	const nestedName = await restarted.admit(nestRequest({ parent: "p/x" }));
	const slashedRequest = await restarted.admit(nestRequest({ childRequestId: "x/c1" }));
	if (nestedName.kind !== "admitted" || slashedRequest.kind !== "admitted") throw new Error("NEST-02: not admitted");
	if (nestedName.child.executionId === slashedRequest.child.executionId)
		throw new Error(`NEST-02: two children share ${nestedName.child.executionId}`);
};

/** NEST-03: siblings together never exceed the parent's reservation; the refused one debits nothing. */
const siblingBudget: NestCase = async (adapters) => {
	const { nested } = await openedParent(adapters);
	expectEqual((await nested.admit(nestRequest({ cost: 6 }))).kind, "admitted", "the first sibling fits");
	expectEqual(
		await nested.admit(nestRequest({ childRequestId: "c2", cost: 5 })),
		refusedWith("budget_exhausted"),
		"6 + 5 exceeds 10",
	);
	expectEqual(await debited(nested), 6, "the refused sibling debited nothing");
	expectEqual((await nested.admit(nestRequest({ childRequestId: "c3", cost: 4 }))).kind, "admitted", "6 + 4 fits");
	for (const cost of [-100, Number.NaN, Number.POSITIVE_INFINITY])
		expectEqual(
			await nested.admit(nestRequest({ childRequestId: `bad-${cost}`, cost })),
			refusedWith("invalid_cost"),
			`cost ${cost}`,
		);
	expectEqual(await debited(nested), 10, "an invalid cost never moves the reservation");
	expectEqual((await nested.cancel("p")).length, 2, "the record still reads: the cancel names both children");
};

/** NEST-04: the parent's executor still has to name the parent's generation and scope. */
const generationAndScope: NestCase = async (adapters) => {
	const { nested } = await openedParent(adapters);
	expectEqual(await nested.admit(nestRequest({ parentGeneration: 2 })), refusedWith("stale_generation"), "generation");
	expectEqual(await nested.admit(nestRequest({ scope: "other" })), refusedWith("scope_mismatch"), "scope");
	expectEqual(await nested.open(nestParent), { kind: "opened" }, "opening the same parent again");
	expectEqual(
		await nested.open({ ...nestParent, generation: 2 }),
		refusedWith("conflicting_parent"),
		"opening it again with another generation",
	);
	const { capabilities, budget, leaseUntil, admittedAt, scope, executor, generation, executionId } = nestParent;
	expectEqual(
		await nested.open({ capabilities, budget, leaseUntil, admittedAt, scope, executor, generation, executionId }),
		{ kind: "opened" },
		"the same parent with its fields in another order",
	);
	for (const field of ["generation", "admittedAt", "leaseUntil", "budget"] as const) {
		const broken = { ...nestParent, executionId: `bad-${field}`, [field]: Number.NaN };
		let threw = false;
		await nested.open(broken).catch(() => {
			threw = true;
		});
		expectEqual([threw, await nested.read(broken.executionId)], [true, undefined], `a NaN ${field} is never written`);
	}
};

/** NEST-05: during preflight only the preparation-phase set admits (a `tool_call` hook's cross-plane call). */
const preparationPhase: NestCase = async (adapters) => {
	const { nested } = await openedParent(adapters);
	expectEqual(await nested.admit(nestRequest()), admitted("c1", "model", false), "a preflight cross-plane call");
	expectEqual(
		await nested.admit(nestRequest({ childRequestId: "c2", target: "e2" })),
		refusedWith("not_in_nested_set"),
		"a body-phase target before release",
	);
};

/** NEST-06: release widens the set to the body phase. */
const releaseWidens: NestCase = async (adapters) => {
	const { nested } = await openedParent(adapters);
	await nested.release("p");
	expectEqual(
		await nested.admit(nestRequest({ childRequestId: "c2", target: "e2" })),
		admitted("c2", "e2", false),
		"a body-phase target after release",
	);
	expectEqual((await nested.admit(nestRequest())).kind, "admitted", "the preparation targets stay");
};

/**
 * NEST-07: a detached cell's later requests are admitted against its registered activity after the invocation ended,
 * within the activity's subset, and refused once the activity ended. The activity never holds more than the parent.
 */
const detachedActivity: NestCase = async (adapters) => {
	const { h, nested } = await openedParent(adapters);
	const expiresAt = nestParent.leaseUntil;
	const activity = { activityId: "a1", parent: "p", executor: "e1", scope: "scope", budget: 3, expiresAt };
	expectEqual(
		await nested.registerActivity({ ...activity, activityId: "early", targets: ["e2"] }),
		refusedWith("exceeds_parent"),
		"a body-phase target before release",
	);
	await nested.release("p");
	for (const [over, what] of [
		[{ targets: ["model", "elsewhere"] }, "a target the parent does not hold"],
		[{ targets: ["model"], expiresAt: expiresAt + 1 }, "an expiry past the parent's"],
		[{ targets: ["model"], budget: 11 }, "a budget over the parent's remaining"],
		[{ targets: ["model"], executor: "e2" }, "another hand"],
	] as const)
		expectEqual(await nested.registerActivity({ ...activity, ...over }), refusedWith("exceeds_parent"), what);
	expectEqual(
		await nested.registerActivity({ ...activity, targets: ["model"] }),
		{ kind: "registered" },
		"registered",
	);
	await nested.settle("p");
	expectEqual(await nested.admit(nestRequest()), refusedWith("parent_terminal"), "the terminal invocation");
	expectEqual(
		await nested.admit(nestRequest({ activityId: "a1" })),
		admitted("c1", "model", false),
		"the live activity",
	);
	expectEqual(
		await nested.admit(nestRequest({ activityId: "a1", childRequestId: "c2", target: "e2" })),
		refusedWith("not_in_nested_set"),
		"outside the activity's subset",
	);
	expectEqual(await nested.admit(nestRequest({ activityId: "a9" })), refusedWith("unknown_activity"), "no such cell");
	await nested.endActivity("p", "a1");
	expectEqual(
		await nested.admit(nestRequest({ activityId: "a1", childRequestId: "c3" })),
		refusedWith("activity_ended"),
		"after the cell ended",
	);
	expectEqual(
		await nested.registerActivity({ ...activity, activityId: "late", targets: ["model"] }),
		refusedWith("parent_terminal"),
		"no activity revives an invocation that ended",
	);
	const fresh = await h.nested();
	await fresh.open({ ...nestParent, executionId: "q" });
	h.advance(LEASE_MS + 1);
	expectEqual(
		await fresh.registerActivity({ ...activity, parent: "q", activityId: "expired", targets: ["model"] }),
		refusedWith("parent_terminal"),
		"nor one whose parent's set expired",
	);
};

/** NEST-08: an activity's children are debited from its own budget and from the parent's reservation. */
const activityBudget: NestCase = async (adapters) => {
	const { nested } = await openedParent(adapters);
	await nested.release("p");
	await nested.registerActivity({
		activityId: "a1",
		parent: "p",
		executor: "e1",
		scope: "scope",
		targets: ["model"],
		budget: 2,
		expiresAt: nestParent.leaseUntil,
	});
	for (const id of ["c1", "c2"])
		expectEqual((await nested.admit(nestRequest({ activityId: "a1", childRequestId: id }))).kind, "admitted", id);
	expectEqual(
		await nested.admit(nestRequest({ activityId: "a1", childRequestId: "c3" })),
		refusedWith("budget_exhausted"),
		"the activity's budget",
	);
	expectEqual((await nested.admit(nestRequest({ childRequestId: "c4", cost: 8 }))).kind, "admitted", "2 + 8 fits");
	expectEqual(
		await nested.admit(nestRequest({ childRequestId: "c5" })),
		refusedWith("budget_exhausted"),
		"the parent's reservation counts the activity's children",
	);
};

/** NEST-09: the nested set expires with the parent's lease; renewals extend it, never past the parent's lifetime. */
const leaseFollowsParent: NestCase = async (adapters) => {
	const { h, nested } = await openedParent(adapters);
	h.advance(LEASE_MS + 1);
	expectEqual(await nested.admit(nestRequest()), refusedWith("expired"), "past the parent's lease");
	expectEqual(await nested.renew("p", nestParent.leaseUntil + LEASE_MS), nestParent.leaseUntil + LEASE_MS, "renewed");
	expectEqual((await nested.admit(nestRequest())).kind, "admitted", "admitted after the renewal");
	expectEqual(await nested.renew("p", NEST_ADMITTED_AT), nestParent.leaseUntil + LEASE_MS, "never moves back");
	expectEqual(
		await nested.renew("p", NEST_ADMITTED_AT + 2 * NESTED_LIFETIME_MS),
		NEST_ADMITTED_AT + NESTED_LIFETIME_MS,
		"capped at the parent's lifetime",
	);
};

export const NEST_CASES: ReadonlyMap<string, NestCase> = new Map([
	["NEST-01", wrongHand],
	["NEST-02", replay],
	["NEST-03", siblingBudget],
	["NEST-04", generationAndScope],
	["NEST-05", preparationPhase],
	["NEST-06", releaseWidens],
	["NEST-07", detachedActivity],
	["NEST-08", activityBudget],
	["NEST-09", leaseFollowsParent],
]);
