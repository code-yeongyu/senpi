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

async function wakePair(h: BatchHarness): Promise<{ outbox: WakeOutbox; inbox: WakeInbox }> {
	return { outbox: await h.wakeOutbox("e1"), inbox: await h.wakeInbox(scopeOwner) };
}

export const ids = (wakes: readonly WakeEvent[]): string[] => wakes.map((wake) => wake.eventId);

/** WAKEX-01: a wake is committed on the hand, committed on the brain, acked, and taken by the loop once. */
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

/** WAKEX-02: a wake whose ack was lost is re-offered and deduplicated by its event id, then acked again. */
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

/** WAKEX-03: wakes offered while the link is down are re-offered on reconnect, in offer order. */
const reconnect: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	const offered = [await outbox.offer(wakeOf(1)), await outbox.offer(wakeOf(2)), await outbox.offer(wakeOf(3))];
	const restarted = await h.wakeOutbox("e1");
	expectEqual(await restarted.reoffer(linkTo(inbox)), 3, "all re-offered after a restart");
	expectEqual(ids((await inbox.read()).pending), ids(offered), "in offer order");
};

/** WAKEX-04: a wake from a hand not bound to the scope, or for a scope the brain does not own, commits nothing. */
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
	await outbox.receipt({ kind: "refused", eventId: wake.eventId, reason: "not_scope_hand" });
	await outbox.receipt({ kind: "refused", eventId: foreign.eventId, reason: "unknown_scope" });
	expectEqual(ids(await outbox.pending()), [wake.eventId, foreign.eventId], "a refusal is never an ack");
	const resent: string[] = [];
	expectEqual(
		await outbox.reoffer(async (sent) => {
			resent.push(sent.eventId);
			return inbox.receive("e2", sent);
		}),
		1,
		"a wake refused for good is never re-offered; an unknown scope is retried",
	);
	expectEqual(resent, [foreign.eventId], "only the unknown-scope wake is sent again");
	await outbox.closeScope("s");
	await outbox.closeScope("elsewhere");
	h.advance(WAKE_RETENTION_MS + 1);
	expectEqual((await outbox.sweep()).length, 2, "refused wakes still expire with their scope");
};

/** WAKEX-05: an un-acked wake outlives its scope by the retention, then is dropped with a logged wake_expired. */
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

/**
 * WAKEX-06: the brain closes a scope: a re-offer of a committed wake is a duplicate within the retention, a new wake
 * for it is refused scope_closed, and once the retention passed the seen ids are dropped but a late re-offer is still
 * refused, never committed twice.
 */
const brainRetention: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	const wake = await outbox.offer(wakeOf(1));
	expectEqual(await inbox.receive("e1", wake), { kind: "ack", eventId: wake.eventId, duplicate: false }, "committed");
	await inbox.closeScope("s");
	expectEqual(await inbox.receive("e1", wake), { kind: "ack", eventId: wake.eventId, duplicate: true }, "a duplicate");
	const late = await outbox.offer(wakeOf(2));
	expectEqual(
		await inbox.receive("e1", late),
		{ kind: "refused", eventId: late.eventId, reason: "scope_closed" },
		"a new wake for a closed scope",
	);
	expectEqual(await inbox.sweep(), [], "kept for the whole retention");
	h.advance(WAKE_RETENTION_MS + 1);
	expectEqual(await inbox.sweep(), ["s"], "the seen ids are dropped after it");
	expectEqual(
		await inbox.receive("e1", wake),
		{ kind: "refused", eventId: wake.eventId, reason: "scope_closed" },
		"a late re-offer is refused, never committed again",
	);
	expectEqual(ids((await inbox.read()).pending), [wake.eventId], "one wake on the brain");
	expectEqual(await inbox.sweep(), [], "a scope is dropped once");
};

/**
 * WAKEX-08: a wake that reaches the brain before its scope is bound (a brain restart, or the bind racing the hand's
 * outbox) is refused unknown_scope but not for good: once the scope binds, the re-offer delivers it exactly once.
 */
const beforeBinding: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	let bound = false;
	const outbox = await h.wakeOutbox("e1");
	const inbox = await h.wakeInbox((scope) => (bound && scope === "s" ? "e1" : undefined));
	const wake = await outbox.offer(wakeOf(1));
	await outbox.reoffer(linkTo(inbox));
	expectEqual(ids(await outbox.pending()), [wake.eventId], "still pending on the hand");
	bound = true;
	expectEqual(await outbox.reoffer(linkTo(inbox)), 1, "re-offered once the scope is bound");
	expectEqual(await outbox.pending(), [], "acked");
	expectEqual(ids((await inbox.read()).pending), [wake.eventId], "delivered once");
};

/** WAKEX-07: two drains at once hand each wake to the loop exactly once. */
const concurrentDrains: WakeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const { outbox, inbox } = await wakePair(h);
	await outbox.offer(wakeOf(1));
	await outbox.offer(wakeOf(2));
	await outbox.reoffer(linkTo(inbox));
	const taken: string[] = [];
	const consume = async (wake: WakeEvent): Promise<void> => {
		taken.push(wake.eventId);
	};
	const [first, second] = await Promise.all([inbox.drain(consume), inbox.drain(consume)]);
	expectEqual(first + second, 2, "two wakes taken in all");
	expectEqual(new Set(taken).size === taken.length && taken.length === 2, true, "each wake once");
};

export const WAKE_EXEC_CASES: ReadonlyMap<string, WakeCase> = new Map([
	["WAKEX-01", delivery],
	["WAKEX-02", dedup],
	["WAKEX-03", reconnect],
	["WAKEX-04", binding],
	["WAKEX-05", retention],
	["WAKEX-06", brainRetention],
	["WAKEX-07", concurrentDrains],
	["WAKEX-08", beforeBinding],
]);
