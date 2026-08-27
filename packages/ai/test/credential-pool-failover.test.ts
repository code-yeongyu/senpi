import { describe, expect, test } from "vitest";
import {
	PoolFailoverError,
	type PoolFailoverEvent,
	runSlotFailover,
	TURN_RETRY_SUPPRESSION_PREFIX,
} from "../src/auth/pool/failover.ts";
import type { SelectableSlot } from "../src/auth/pool/select.ts";

type Event = { type: string; text?: string };

const NOW = 1_756_000_000_000;

function firstUnblocked(slots: readonly SelectableSlot[]): SelectableSlot {
	const found = slots.find((slot) => slot.blockedUntil === undefined && slot.blockReason === undefined);
	if (!found) throw new Error("no unblocked slot");
	return found;
}

async function* events(...items: Event[]): AsyncGenerator<Event> {
	for (const item of items) yield item;
}

async function* failWith(error: unknown, ...items: Event[]): AsyncGenerator<Event> {
	for (const item of items) yield item;
	throw error;
}

async function collect(stream: AsyncGenerator<Event>): Promise<Event[]> {
	const seen: Event[] = [];
	for await (const event of stream) seen.push(event);
	return seen;
}

describe("credential pool slot failover", () => {
	test("a pre-output 429 rotates to the next slot and blocks the failed one", async () => {
		const persisted: SelectableSlot[] = [];
		const rotations: PoolFailoverEvent<SelectableSlot>[] = [];
		const attempts: string[] = [];
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return slot.name === "alpha"
					? failWith({ status: 429, message: "rate limited" })
					: events({ type: "text_delta", text: "ok" });
			},
			persistBlock: (slot) => {
				persisted.push(slot);
			},
			onRotate: (event) => {
				rotations.push(event);
			},
			now: () => NOW,
		});
		const seen = await collect(stream);
		expect(attempts).toEqual(["alpha", "beta"]);
		expect(seen).toEqual([{ type: "text_delta", text: "ok" }]);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ name: "alpha", blockReason: "rate_limit" });
		expect(persisted[0]?.blockedUntil).toBeGreaterThan(NOW);
		expect(rotations[0]?.nextSlot?.name).toBe("beta");
	});

	test("default-DENY: any yielded event commits the turn and suppresses rotation", async () => {
		const attempts: string[] = [];
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return failWith({ status: 429, message: "rate limited" }, { type: "unknown_frame" });
			},
			now: () => NOW,
		});
		const seen: Event[] = [];
		let caught: unknown;
		try {
			for await (const event of stream) seen.push(event);
		} catch (error) {
			caught = error;
		}
		expect(attempts).toEqual(["alpha"]);
		expect(seen).toEqual([{ type: "unknown_frame" }]);
		expect(caught).toBeInstanceOf(PoolFailoverError);
		expect((caught as PoolFailoverError).suppressTurnRetry).toBe(true);
		expect((caught as PoolFailoverError).message.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)).toBe(true);
	});

	test("an explicit isCommittedOutput keeps rotation transparent for bookkeeping events", async () => {
		const attempts: string[] = [];
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return slot.name === "alpha"
					? failWith({ status: 429, message: "rate limited" }, { type: "bookkeeping" })
					: events({ type: "text_delta", text: "ok" });
			},
			isCommittedOutput: (event) => event.type === "text_delta",
			now: () => NOW,
		});
		const seen = await collect(stream);
		expect(attempts).toEqual(["alpha", "beta"]);
		expect(seen).toEqual([{ type: "bookkeeping" }, { type: "text_delta", text: "ok" }]);
	});

	test("an auth failure blocks the slot without an expiry", async () => {
		const persisted: SelectableSlot[] = [];
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: (slot) =>
				slot.name === "alpha"
					? failWith({ status: 401, message: "unauthorized" })
					: events({ type: "text_delta", text: "ok" }),
			persistBlock: (slot) => {
				persisted.push(slot);
			},
			now: () => NOW,
		});
		await collect(stream);
		expect(persisted[0]).toMatchObject({ name: "alpha", blockReason: "auth_error" });
		expect(persisted[0]?.blockedUntil).toBeUndefined();
	});

	test("a fail-class error throws immediately without trying siblings", async () => {
		const attempts: string[] = [];
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return failWith(new Error("model produced invalid tool arguments"));
			},
			now: () => NOW,
		});
		await expect(collect(stream)).rejects.toBeInstanceOf(PoolFailoverError);
		expect(attempts).toEqual(["alpha"]);
	});

	test("a retry-class error throws for the outer retry policy without rotation", async () => {
		const attempts: string[] = [];
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return failWith({ status: 503, message: "service unavailable" });
			},
			now: () => NOW,
		});
		let caught: unknown;
		try {
			await collect(stream);
		} catch (error) {
			caught = error;
		}
		expect(attempts).toEqual(["alpha"]);
		expect(caught).toBeInstanceOf(PoolFailoverError);
		expect((caught as PoolFailoverError).classification.action).toBe("retry");
		expect((caught as PoolFailoverError).suppressTurnRetry).toBe(false);
	});

	test("exhausting every slot rethrows the last rotate-class failure", async () => {
		const stream = runSlotFailover<Event, SelectableSlot>({
			slots: [{ name: "alpha" }, { name: "beta" }],
			select: firstUnblocked,
			runAttempt: () => failWith({ status: 429, message: "rate limited" }),
			now: () => NOW,
		});
		let caught: unknown;
		try {
			await collect(stream);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PoolFailoverError);
		expect((caught as PoolFailoverError).classification.action).toBe("rotate");
	});
});
