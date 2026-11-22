import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { nestedChildId } from "../nested.ts";
import type { NestedCancelTarget } from "../nested-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { BrainKilledError, batchHarness, expectRejects } from "./batch-harness.ts";
import { cancelTargetOf } from "./cancel-cases.ts";
import { admitted, debited, nestParent, nestRequest } from "./nest-cases.ts";

type KillNestCase = CaseImplementation<BatchCaseAdapters>;

async function killedAround(adapters: BatchCaseAdapters, label: string, at: "before" | "after") {
	const h = await batchHarness(adapters);
	await (await h.nested()).open(nestParent);
	await (await h.nested()).release("p");
	return { h, dying: await h.nested({ label, at }) };
}

/** KILL-NEST-01: the brain dies before the admission is durable: nothing was debited, the retry admits it once. */
const beforeAdmission: KillNestCase = async (adapters) => {
	const { h, dying } = await killedAround(adapters, `admit:${nestedChildId("p", "c1")}`, "before");
	await expectRejects(dying.admit(nestRequest()), BrainKilledError, "the dying admission");
	const restarted = await h.nested();
	expectEqual(await debited(restarted), 0, "nothing durable");
	expectEqual(await restarted.admit(nestRequest()), admitted("c1", "model", false), "admitted on the retry");
	expectEqual(await debited(restarted), 1, "debited once");
};

/** KILL-NEST-02: the brain dies after the admission is durable, before replying: the retry gets the same child. */
const afterAdmission: KillNestCase = async (adapters) => {
	const { h, dying } = await killedAround(adapters, `admit:${nestedChildId("p", "c1")}`, "after");
	await expectRejects(dying.admit(nestRequest()), BrainKilledError, "the dying admission");
	const restarted = await h.nested();
	expectEqual(await restarted.admit(nestRequest()), admitted("c1", "model", true), "the same child");
	expectEqual(await debited(restarted), 1, "never debited twice");
};

/**
 * KILL-NEST-03: the brain dies after the cancel is durable (before any delivery), then again after a delivery was sent
 * but before it was recorded: each restart re-sends the cascade until it is recorded, and nothing else is sent.
 */
const aroundCascade: KillNestCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const nested = await h.nested();
	await nested.open(nestParent);
	await nested.release("p");
	await nested.admit(nestRequest({ target: "e2" }));
	await expectRejects(
		(await h.nested({ label: "cancel", at: "after" })).cancel("p"),
		BrainKilledError,
		"dies after the cancel",
	);
	expectEqual(
		(await (await h.nested()).read("p"))?.cancels,
		{ [nestedChildId("p", "c1")]: "queued" },
		"the cascade is durable",
	);
	const sent: NestedCancelTarget[] = [];
	const send = async (target: NestedCancelTarget): Promise<void> => {
		sent.push(target);
	};
	await expectRejects(
		(await h.nested({ label: `cancel_delivered:${nestedChildId("p", "c1")}`, at: "before" })).deliverCancels(
			"p",
			send,
		),
		BrainKilledError,
		"dies after sending, before recording",
	);
	expectEqual(await (await h.nested()).deliverCancels("p", send), 1, "the restart re-sends it");
	expectEqual(await (await h.nested()).deliverCancels("p", send), 0, "recorded: never sent again");
	expectEqual(sent, [cancelTargetOf("c1", "e2"), cancelTargetOf("c1", "e2")], "sent until recorded");
};

export const KILL_NEST_CASES: ReadonlyMap<string, KillNestCase> = new Map([
	["KILL-NEST-01", beforeAdmission],
	["KILL-NEST-02", afterAdmission],
	["KILL-NEST-03", aroundCascade],
]);
