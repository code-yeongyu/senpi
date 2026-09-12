import { describe, expect, test } from "vitest";
import {
	CredentialFailoverError,
	type RunSlot,
	runCredentialFailover,
	TURN_RETRY_SUPPRESSION_PREFIX,
} from "../src/core/credential-pool/failover.ts";

type Event = { type: string };

function rateLimited(): Error {
	return Object.assign(new Error("rate limited"), { status: 429 });
}

async function* ok(): AsyncGenerator<Event> {
	yield { type: "text_delta" };
}

async function* fail(error: unknown): AsyncGenerator<Event> {
	throw error;
	// biome-ignore lint/correctness/noUnreachable: generator needs a yield type
	yield { type: "never" };
}

/**
 * Drives the credential runner the way the session layer composes it: the
 * model fallback chain (tryFallback) is consulted only when the runner itself
 * gives up, never once per slot.
 */
async function driveRequest(slots: RunSlot[], failing: Set<string>) {
	let fallbackCalls = 0;
	const attempts: string[] = [];
	const stream = runCredentialFailover<Event, RunSlot>({
		listSlots: () => slots,
		select: (candidates) => {
			const slot = candidates[0];
			if (!slot) throw new Error("no candidate");
			return slot;
		},
		runAttempt: (slot) => {
			attempts.push(slot.name);
			return failing.has(slot.name) ? fail(rateLimited()) : ok();
		},
		isCommittedOutput: (event) => event.type !== "bookkeeping",
		persistBlock: (slot) => {
			const index = slots.findIndex((candidate) => candidate.name === slot.name);
			slots[index] = { ...slot, blockedUntil: Number.MAX_SAFE_INTEGER, blockReason: "rate_limit" };
		},
	});
	try {
		const seen: Event[] = [];
		for await (const event of stream) seen.push(event);
		return { attempts, fallbackCalls, seen, error: undefined };
	} catch (error) {
		// The model chain is the layer ABOVE this runner: one consultation per
		// exhausted lane, exactly like agent-session routes terminal errors.
		fallbackCalls += 1;
		return { attempts, fallbackCalls, seen: [], error };
	}
}

describe("credential rotation composes below the model fallback chain", () => {
	test("a 429 with a healthy sibling rotates in-lane and never reaches tryFallback", async () => {
		const result = await driveRequest([{ name: "alpha" }, { name: "beta" }], new Set(["alpha"]));
		expect(result.attempts).toEqual(["alpha", "beta"]);
		expect(result.seen).toEqual([{ type: "text_delta" }]);
		expect(result.fallbackCalls).toBe(0);
	});

	test("a 429 with every slot blocked reaches the model chain exactly once", async () => {
		const result = await driveRequest([{ name: "alpha" }, { name: "beta" }], new Set(["alpha", "beta"]));
		expect(result.attempts).toEqual(["alpha", "beta"]);
		expect(result.fallbackCalls).toBe(1);
		expect(result.error).toBeInstanceOf(CredentialFailoverError);
	});

	test("the runner emits the exact marker the session layer already suppresses on", () => {
		// agent-session.ts consumes this string on message.errorMessage; the
		// engine constant must stay byte-identical for the Claude path to remain
		// suppressed by the same mechanism.
		expect(TURN_RETRY_SUPPRESSION_PREFIX).toBe("senpi:no-turn-retry:");
	});
});
