import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { WakeInbox } from "../wake-inbox.ts";
import type { WakeOutbox } from "../wake-outbox.ts";
import { WAKE_RETENTION_MS, type WakeEvent, type WakeReceipt } from "../wake-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { type BatchHarness, batchHarness } from "./batch-harness.ts";

type WakeCase = CaseImplementation<BatchCaseAdapters>;

/** Scope `s` belongs to hand `e1`; every other scope is not this brain's. */
export const scopeOwner = (scope: string): string | undefined => (scope === "s" ? "e1" : undefined);

export const wakeOf = (n: number, scope = "s") => ({ scope, source: "terminal", payload: { n } });

/** The hand's link to the brain: a send is the inbox's answer, which the outbox then applies. */
export const linkTo =
	(inbox: WakeInbox, hand = "e1") =>
	(wake: WakeEvent): Promise<WakeReceipt> =>
		inbox.receive(hand, wake);

export async function wakePair(h: BatchHarness): Promise<{ outbox: WakeOutbox; inbox: WakeInbox }> {
	return { outbox: await h.wakeOutbox("e1"), inbox: await h.wakeInbox(scopeOwner) };
}

export const ids = (wakes: readonly WakeEvent[]): string[] => wakes.map((wake) => wake.eventId);

/** WAKE-EXEC-01: a wake is committed on the hand, committed on the brain, acked, and taken by the loop once. */
const delivery: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	const wake = await outbox.offer(wakeOf(1));
	expectEqual(ids(await outbox.pending()), [wake.eventId], "durable on the hand before it is sent");
	expectEqual(await outbox.reoffer(linkTo(inbox)), 1, "sent");
	expectEqual(await outbox.pending(), [], "removed by its ack");
	const taken: WakeEvent[] = [];
	expectEqual(await inbox.drain(async (got) => void taken.push(got)), 1, "taken");
	expectEqual(taken, [wake], "the loop gets the wake once");
	expectEqual(await inbox.drain(async () => {}), 0, "and never again");
};

/** WAKE-EXEC-02: a wake whose ack was lost is re-offered and deduplicated by its event id, then acked again. */
const dedup: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	const wake = await outbox.offer(wakeOf(1));
	expectEqual(await inbox.receive("e1", wake), { kind: "ack", eventId: wake.eventId, duplicate: false }, "committed");
	expectEqual(ids(await outbox.pending()), [wake.eventId], "the ack was lost");
	await outbox.reoffer(linkTo(inbox));
	expectEqual(await outbox.pending(), [], "the duplicate's ack removes it");
	expectEqual(ids((await inbox.read()).pending), [wake.eventId], "one wake on the brain");
};

/** WAKE-EXEC-03: wakes offered while the link is down are re-offered on reconnect, in offer order. */
const reconnect: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	const offered = [await outbox.offer(wakeOf(1)), await outbox.offer(wakeOf(2)), await outbox.offer(wakeOf(3))];
	const restarted = await h.wakeOutbox("e1");
	expectEqual(await restarted.reoffer(linkTo(inbox)), 3, "all re-offered after a restart");
	expectEqual(ids((await inbox.read()).pending), ids(offered), "in offer order");
};

/** WAKE-EXEC-04: a wake from a hand not bound to the scope, or for a scope the brain does not own, commits nothing. */
const binding: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	const wake = await outbox.offer(wakeOf(1));
	expectEqual(
		await inbox.receive("e2", wake),
		{ kind: "refused", eventId: wake.eventId, reason: "not_scope_hand" },
		"another hand",
	);
	const foreign = await outbox.offer(wakeOf(2, "elsewhere"));
	expectEqual(
		await inbox.receive("e1", foreign),
		{ kind: "refused", eventId: foreign.eventId, reason: "unknown_scope" },
		"a scope this brain does not own",
	);
	expectEqual(await inbox.read(), { seen: {}, pending: [], closed: {} }, "nothing committed");
	await outbox.reoffer(async (sent) => inbox.receive("e2", sent));
	expectEqual(ids(await outbox.pending()), [wake.eventId, foreign.eventId], "a refusal is never an ack");
};

/** WAKE-EXEC-05: an un-acked wake outlives its scope by the retention, then is dropped with a logged wake_expired. */
const retention: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const outbox = await h.wakeOutbox("e1");
	const wake = await outbox.offer(wakeOf(1));
	expectEqual(await outbox.sweep(), [], "an open scope never expires");
	await outbox.closeScope("s");
	h.advance(WAKE_RETENTION_MS);
	expectEqual(await outbox.sweep(), [], "kept for the whole retention");
	h.advance(1);
	expectEqual(await outbox.sweep(), [wake.eventId], "dropped after it");
	expectEqual(await outbox.pending(), [], "gone");
	const logged = await h.wakeLog("e1");
	expectEqual(logged, [{ reason: "wake_expired", eventId: wake.eventId, scope: "s" }], "logged as wake_expired");
};

export const WAKE_EXEC_CASES: ReadonlyMap<string, WakeCase> = new Map([
	["WAKE-EXEC-01", delivery],
	["WAKE-EXEC-02", dedup],
	["WAKE-EXEC-03", reconnect],
	["WAKE-EXEC-04", binding],
	["WAKE-EXEC-05", retention],
]);
