import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { NestedCancelTarget } from "../nested-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { admitted, nestParent, nestRequest, openedParent, refusedWith } from "./nest-cases.ts";

type CancelCase = CaseImplementation<BatchCaseAdapters>;

export const cancelTargetOf = (childRequestId: string, executor: string): NestedCancelTarget => ({
	ref: { issuer: "brain", executionId: `p/${childRequestId}`, generation: 1 },
	executor,
});

/** CANCEL-01: the parent cancel commits before the child's admission: the child is refused, its activity too. */
const cancelFirst: CancelCase = async (adapters) => {
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
	expectEqual(await nested.cancel("p"), [], "no child to cascade to");
	expectEqual(await nested.admit(nestRequest()), refusedWith("parent_terminal"), "a child racing the cancel");
	expectEqual(
		await nested.admit(nestRequest({ activityId: "a1" })),
		refusedWith("activity_ended"),
		"the cancel binding ended the activity",
	);
	expectEqual(
		await nested.registerActivity({
			activityId: "a2",
			parent: "p",
			executor: "e1",
			scope: "scope",
			targets: ["model"],
			budget: 1,
			expiresAt: nestParent.leaseUntil,
		}),
		refusedWith("parent_terminal"),
		"no new activity after the cancel",
	);
};

/**
 * CANCEL-02: the child's admission commits before the parent cancel: the child exists and the cancel durably cascades
 * to its executor, delivered once it is taken and re-sent by a restarted brain until then.
 */
const admittedFirst: CancelCase = async (adapters) => {
	const { h, nested } = await openedParent(adapters);
	await nested.release("p");
	expectEqual(
		await nested.admit(nestRequest({ target: "e2" })),
		admitted("c1", "e2", false),
		"admitted before the cancel",
	);
	expectEqual(await nested.cancel("p"), [cancelTargetOf("c1", "e2")], "the cancel names the child");
	expectEqual((await nested.read("p"))?.cancels, { "p/c1": "queued" }, "the cascade is durable before delivery");
	const refused: NestedCancelTarget[] = [];
	await nested
		.deliverCancels("p", async (target) => {
			refused.push(target);
			throw new Error("the child's executor is unreachable");
		})
		.catch(() => undefined);
	const restarted = await h.nested();
	const sent: NestedCancelTarget[] = [];
	expectEqual(
		await restarted.deliverCancels("p", async (target) => {
			sent.push(target);
		}),
		1,
		"a restarted brain re-sends it",
	);
	expectEqual([refused, sent], [[cancelTargetOf("c1", "e2")], [cancelTargetOf("c1", "e2")]], "both sends");
	expectEqual(await restarted.deliverCancels("p", async () => {}), 0, "delivered once taken");
	expectEqual(
		await restarted.admit(nestRequest({ target: "e2" })),
		admitted("c1", "e2", true),
		"the admitted child still exists",
	);
};

export const CANCEL_CASES: ReadonlyMap<string, CancelCase> = new Map([
	["CANCEL-01", cancelFirst],
	["CANCEL-02", admittedFirst],
]);
