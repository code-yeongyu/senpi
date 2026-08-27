import { describe, expect, test } from "vitest";
import {
	CredentialFailoverError,
	type RunSlot,
	runCredentialFailover,
	TURN_RETRY_SUPPRESSION_PREFIX,
} from "../src/core/credential-pool/failover.ts";

type Event = { type: string };

function firstAvailable(slots: readonly RunSlot[]): RunSlot {
	const slot = slots[0];
	if (!slot) throw new Error("no candidate slot");
	return slot;
}

async function* events(...items: Event[]): AsyncGenerator<Event> {
	for (const item of items) yield item;
}

async function* failWith(error: unknown, ...items: Event[]): AsyncGenerator<Event> {
	for (const item of items) yield item;
	throw error;
}

function rateLimited(): Error {
	return Object.assign(new Error("rate limited"), { status: 429 });
}

/** Only bookkeeping frames are pre-commit; everything unknown counts as committed. */
function committedUnlessBookkeeping(event: Event): boolean {
	return event.type !== "bookkeeping";
}

async function collect(stream: AsyncGenerator<Event>): Promise<Event[]> {
	const seen: Event[] = [];
	for await (const event of stream) seen.push(event);
	return seen;
}

describe("generic credential failover runner", () => {
	test("rotation happens before the first delta and the block persists before replacement", async () => {
		const order: string[] = [];
		const stream = runCredentialFailover<Event, RunSlot>({
			listSlots: () => {
				order.push("list");
				return [{ name: "alpha" }, { name: "beta" }];
			},
			select: (slots) => {
				order.push(`select:${slots.map((slot) => slot.name).join(",")}`);
				return firstAvailable(slots);
			},
			runAttempt: (slot) => {
				order.push(`attempt:${slot.name}`);
				return slot.name === "alpha" ? failWith(rateLimited()) : events({ type: "text_delta" });
			},
			isCommittedOutput: committedUnlessBookkeeping,
			persistBlock: (slot, block) => {
				order.push(`persist:${slot.name}:${block.reason}`);
			},
		});
		const seen = await collect(stream);
		expect(seen).toEqual([{ type: "text_delta" }]);
		// The block lands before the replacement slot is even listed or selected.
		expect(order).toEqual([
			"list",
			"select:alpha,beta",
			"attempt:alpha",
			"persist:alpha:rate_limit",
			"list",
			"select:beta",
			"attempt:beta",
		]);
	});

	test("an UNKNOWN event type sets the committed-output barrier: no rotation, marked error", async () => {
		const attempts: string[] = [];
		const persisted: string[] = [];
		const stream = runCredentialFailover<Event, RunSlot>({
			listSlots: () => [{ name: "alpha" }, { name: "beta" }],
			select: firstAvailable,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return failWith(rateLimited(), { type: "mystery_frame" });
			},
			isCommittedOutput: committedUnlessBookkeeping,
			persistBlock: (slot) => {
				persisted.push(slot.name);
			},
		});
		let caught: unknown;
		try {
			await collect(stream);
		} catch (error) {
			caught = error;
		}
		expect(attempts).toEqual(["alpha"]);
		// The applicable block still persists even though rotation is barred.
		expect(persisted).toEqual(["alpha"]);
		expect(caught).toBeInstanceOf(CredentialFailoverError);
		expect((caught as CredentialFailoverError).suppressTurnRetry).toBe(true);
		expect((caught as CredentialFailoverError).message.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)).toBe(true);
	});

	test("a newly added slot participates because slots re-read per attempt", async () => {
		let reads = 0;
		const attempts: string[] = [];
		const stream = runCredentialFailover<Event, RunSlot>({
			listSlots: () => {
				reads += 1;
				return reads === 1 ? [{ name: "alpha" }] : [{ name: "alpha" }, { name: "fresh" }];
			},
			select: firstAvailable,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return slot.name === "fresh" ? events({ type: "text_delta" }) : failWith(rateLimited());
			},
			isCommittedOutput: committedUnlessBookkeeping,
			persistBlock: () => {},
		});
		await collect(stream);
		expect(attempts).toEqual(["alpha", "fresh"]);
	});

	test("retry_same reruns the same slot at most twice without blocking it", async () => {
		const attempts: string[] = [];
		const persisted: string[] = [];
		const stream = runCredentialFailover<Event, RunSlot>({
			listSlots: () => [{ name: "alpha" }, { name: "beta" }],
			select: firstAvailable,
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return failWith(Object.assign(new Error("overloaded"), { status: 529 }));
			},
			isCommittedOutput: committedUnlessBookkeeping,
			persistBlock: (slot) => {
				persisted.push(slot.name);
			},
		});
		let caught: unknown;
		try {
			await collect(stream);
		} catch (error) {
			caught = error;
		}
		expect(attempts).toEqual(["alpha", "alpha"]);
		expect(persisted).toEqual([]);
		expect((caught as CredentialFailoverError).action.kind).toBe("retry_same");
		expect((caught as CredentialFailoverError).suppressTurnRetry).toBe(false);
	});

	test("pool exhaustion carries retryAt and the original error as cause", async () => {
		const NOW = 1_756_000_000_000;
		let blocked: { name: string; blockedUntil: number } | undefined;
		const original = rateLimited();
		const stream = runCredentialFailover<Event, RunSlot>({
			listSlots: () =>
				blocked
					? [{ name: "alpha", blockedUntil: blocked.blockedUntil, blockReason: "rate_limit" }]
					: [{ name: "alpha" }],
			select: firstAvailable,
			runAttempt: () => failWith(original),
			isCommittedOutput: committedUnlessBookkeeping,
			persistBlock: (slot, block) => {
				const cooldownMs = block.reason === "rate_limit" ? block.cooldownMs : 0;
				blocked = { name: slot.name, blockedUntil: NOW + cooldownMs };
			},
			now: () => NOW,
		});
		let caught: unknown;
		try {
			await collect(stream);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CredentialFailoverError);
		const failure = caught as CredentialFailoverError;
		expect(failure.retryAt).toBe(NOW + 60_000);
		expect(failure.cause).toBe(original);
	});
});
