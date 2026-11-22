import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { WakeEvent } from "../wake-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { BrainKilledError, batchHarness, expectRejects } from "./batch-harness.ts";
import { ids, linkTo, scopeOwner, wakeOf } from "./wake-exec-cases.ts";

type KillWakeCase = CaseImplementation<BatchCaseAdapters>;

/** KILL-WAKEX-01: the hand dies before the offer is durable: there is nothing to re-offer and nothing reached the brain. */
const beforeOffer: KillWakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	await expectRejects(
		(await h.wakeOutbox("e1", { label: "offer", at: "before" })).offer(wakeOf(1)),
		BrainKilledError,
		"the dying offer",
	);
	expectEqual(await (await h.wakeOutbox("e1")).pending(), [], "nothing durable");
};

/** KILL-WAKEX-02: the hand dies after the offer is durable, before sending it: its restart re-offers it once. */
const afterOffer: KillWakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	await expectRejects(
		(await h.wakeOutbox("e1", { label: "offer", at: "after" })).offer(wakeOf(1)),
		BrainKilledError,
		"the dying offer",
	);
	const outbox = await h.wakeOutbox("e1");
	const inbox = await h.wakeInbox(scopeOwner);
	expectEqual(await outbox.reoffer(linkTo(inbox)), 1, "re-offered after the restart");
	expectEqual((await inbox.read()).pending.length, 1, "delivered once");
	expectEqual(await outbox.pending(), [], "acked");
};

/** KILL-WAKEX-03: the brain dies before the inbox commit: no ack was sent, so the re-offer delivers it once. */
const beforeCommit: KillWakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const outbox = await h.wakeOutbox("e1");
	const wake = await outbox.offer(wakeOf(1));
	const dying = await h.wakeInbox(scopeOwner, { label: `commit:${wake.eventId}`, at: "before" });
	await expectRejects(outbox.reoffer(linkTo(dying)), BrainKilledError, "the dying commit");
	expectEqual(ids(await outbox.pending()), [wake.eventId], "never acked");
	const inbox = await h.wakeInbox(scopeOwner);
	await outbox.reoffer(linkTo(inbox));
	expectEqual(ids((await inbox.read()).pending), [wake.eventId], "committed once");
	expectEqual(await outbox.pending(), [], "acked after the commit");
};

/** KILL-WAKEX-04: the brain dies after the inbox commit, before its ack left: the re-offer is a duplicate, then acked. */
const afterCommit: KillWakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const outbox = await h.wakeOutbox("e1");
	const wake = await outbox.offer(wakeOf(1));
	const dying = await h.wakeInbox(scopeOwner, { label: `commit:${wake.eventId}`, at: "after" });
	await expectRejects(outbox.reoffer(linkTo(dying)), BrainKilledError, "the dying ack");
	const inbox = await h.wakeInbox(scopeOwner);
	await outbox.reoffer(linkTo(inbox));
	expectEqual(ids((await inbox.read()).pending), [wake.eventId], "one wake on the brain");
	expectEqual(await outbox.pending(), [], "the duplicate's ack removed it");
};

/** KILL-WAKEX-05: the hand dies after the ack arrived, before recording it: the re-offer is a duplicate, acked again. */
const beforeAckRecord: KillWakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const offered = await (await h.wakeOutbox("e1")).offer(wakeOf(1));
	const inbox = await h.wakeInbox(scopeOwner);
	await expectRejects(
		(await h.wakeOutbox("e1", { label: "ack", at: "before" })).reoffer(linkTo(inbox)),
		BrainKilledError,
		"the dying ack record",
	);
	const outbox = await h.wakeOutbox("e1");
	expectEqual(ids(await outbox.pending()), [offered.eventId], "still pending on the hand");
	await outbox.reoffer(linkTo(inbox));
	expectEqual(await outbox.pending(), [], "acked by the duplicate");
	expectEqual(ids((await inbox.read()).pending), [offered.eventId], "never a second wake");
};

/**
 * KILL-WAKEX-06: the brain dies after the loop took a wake, before recording it: the restart hands the same wake (same
 * id) over again, so the loop's consumer must be idempotent by event id; nothing is lost.
 */
const beforeTakeRecord: KillWakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const outbox = await h.wakeOutbox("e1");
	const wake = await outbox.offer(wakeOf(1));
	await outbox.reoffer(linkTo(await h.wakeInbox(scopeOwner)));
	const taken: WakeEvent[] = [];
	const consume = async (got: WakeEvent): Promise<void> => void taken.push(got);
	await expectRejects(
		(await h.wakeInbox(scopeOwner, { label: `take:${wake.eventId}`, at: "before" })).drain(consume),
		BrainKilledError,
		"the dying take",
	);
	expectEqual(await (await h.wakeInbox(scopeOwner)).drain(consume), 1, "handed over again after the restart");
	expectEqual(ids(taken), [wake.eventId, wake.eventId], "the same wake, by the same id");
	expectEqual(await (await h.wakeInbox(scopeOwner)).drain(consume), 0, "then recorded");
};

export const KILL_WAKEX_CASES: ReadonlyMap<string, KillWakeCase> = new Map([
	["KILL-WAKEX-01", beforeOffer],
	["KILL-WAKEX-02", afterOffer],
	["KILL-WAKEX-03", beforeCommit],
	["KILL-WAKEX-04", afterCommit],
	["KILL-WAKEX-05", beforeAckRecord],
	["KILL-WAKEX-06", beforeTakeRecord],
]);
