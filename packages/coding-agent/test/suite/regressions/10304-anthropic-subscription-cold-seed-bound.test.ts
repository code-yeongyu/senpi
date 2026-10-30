import { type AssistantMessage, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	type FailoverOptions,
	forgetSessionBlocksFor,
	runFailover,
} from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { providerRetryAt, providerRetryDelayMs } from "../../../src/core/extensions/builtin/goal/provider-retry.ts";

/**
 * oh-my-openagent#10304, root cause 4: Anthropic prompt caches are per organization and every subscription
 * seat is its own organization, so an attempt on any seat other than the one that holds the session's cache
 * (the warm seat) re-sends the whole conversation uncached. One failing turn may pay that at most once:
 * the warm seat is preferred, at most one other (cold) seat is tried per turn once the warm seat cannot serve,
 * the turn's retries may run again only on that cold seat (it already holds the prefix), and no further seat is
 * seeded in that turn.
 *
 * The fake provider below records every dispatch per seat. The clock is fixed and the transient back-off is a
 * recording no-op, so nothing here waits.
 */

const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1_000;
const PROVIDER = "anthropic-subscription";
/** The session's own turn retries on top of the first try (the default turn profile retries 5 times). */
const SESSION_TURN_RETRIES = 5;

const seats: AccountSlot[] = ["warm", "seat-b", "seat-c", "seat-d"].map((name) => ({
	name,
	refresh: `r-${name}`,
	access: `a-${name}`,
	expires: NOW + 10 * HOUR_MS,
	source: "login" as const,
}));

type Event = { type: "done"; seat: string };
/** The cold-seat inputs this regression drives; typed here so the file also compiles against the pre-fix sources. */
type ColdSeatOptions = FailoverOptions<Event> & { warmAccount?: string; turnKey?: string };
type Reply = "ok" | "rate_limit" | "long_limit" | "server_error" | "usage_limit";

const REPLY_ERROR: Record<Exclude<Reply, "ok">, string> = {
	rate_limit: `rate_limit retry-after-ms: ${HOUR_MS}`,
	long_limit: `rate_limit retry-after-ms: ${3 * HOUR_MS}`,
	server_error: "server_error",
	usage_limit: "You've hit your session limit \u00b7 resets in 4 hours",
};

async function storeWithSeats(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () =>
		seats.reduce<AnthropicSubscriptionCredential>(
			(credential, seat) => addAccount(credential, seat),
			emptyCredential(),
		),
	);
	return store;
}

async function storedSeats(store: CredentialStore): Promise<AccountSlot[]> {
	const credential = (await store.read(PROVIDER)) as AnthropicSubscriptionCredential;
	return credential.accounts ?? [];
}

class FakeSeats {
	readonly dispatches: { session: string; seat: string; tryId: number }[] = [];
	private tries = 0;
	private readonly reply: (seat: string) => Reply;
	constructor(reply: (seat: string) => Reply) {
		this.reply = reply;
	}

	attempt(session: string) {
		const record = this.dispatches;
		const reply = this.reply;
		const tryId = this.tries++;
		return async function* (slot: AccountSlot): AsyncGenerator<Event> {
			record.push({ session, seat: slot.name, tryId });
			const answer = reply(slot.name);
			if (answer !== "ok") throw new Error(REPLY_ERROR[answer]);
			yield { type: "done", seat: slot.name };
		};
	}

	coldSeeds(session: string, warm: string): string[] {
		return this.dispatches.filter((d) => d.session === session && d.seat !== warm).map((d) => d.seat);
	}

	triesThatDispatched(session: string): number {
		return new Set(this.dispatches.filter((d) => d.session === session).map((d) => d.tryId)).size;
	}
}

async function tryTurn(input: {
	store: CredentialStore;
	fake: FakeSeats;
	session: string;
	warm: string;
	turnKey: string;
	pinned?: string;
	at?: number;
}): Promise<{ ok: true; seat: string } | { ok: false; error: unknown }> {
	const accounts = await storedSeats(input.store);
	const at = input.at ?? NOW;
	try {
		const events: Event[] = [];
		const options: ColdSeatOptions = {
			accounts,
			selectFn: (pool) =>
				selectAccount(pool, {
					sessionId: input.session,
					preferredAccount: input.warm,
					...(input.pinned === undefined ? {} : { pinnedAccount: input.pinned }),
					now: at,
				}),
			runAttempt: input.fake.attempt(input.session),
			classify: classifySdkError,
			store: input.store,
			providerId: PROVIDER,
			now: () => at,
			sleep: async () => {},
			sessionKey: input.session,
			warmAccount: input.warm,
			turnKey: input.turnKey,
		};
		for await (const event of runFailover<Event>(options)) events.push(event);
		return { ok: true, seat: events.at(-1)?.seat ?? "" };
	} catch (error) {
		return { ok: false, error };
	}
}

async function failingTurn(input: Parameters<typeof tryTurn>[0]) {
	const results: Awaited<ReturnType<typeof tryTurn>>[] = [];
	for (let attempt = 0; attempt <= SESSION_TURN_RETRIES; attempt++) {
		const result = await tryTurn(input);
		results.push(result);
		if (result.ok) break;
	}
	return results;
}

type BlockedTurn = { name: string; warmAccount: string; coldAccount: string; soonestUnblockAt: number | undefined };

function blockedTurn(result: Awaited<ReturnType<typeof tryTurn>> | undefined): BlockedTurn | undefined {
	return result && !result.ok ? (result.error as BlockedTurn) : undefined;
}

afterEach(() => {
	for (const seat of seats) forgetSessionBlocksFor(seat.name);
});

describe("oh-my-openagent#10304: one failing turn seeds at most one cold seat", () => {
	it("a cold seat that keeps failing transiently is the turn's only cold seat; its retries re-send the prefix it already holds", async () => {
		const store = await storeWithSeats();
		// The warm seat hits a rate limit; every other seat answers a server error.
		const fake = new FakeSeats((seat) => (seat === "warm" ? "rate_limit" : "server_error"));

		const results = await failingTurn({ store, fake, session: "s-transient", warm: "warm", turnKey: "turn-1" });

		expect(new Set(fake.coldSeeds("s-transient", "warm")).size).toBe(1);
		expect(fake.triesThatDispatched("s-transient")).toBe(SESSION_TURN_RETRIES + 1);
		for (const result of results) expect(blockedTurn(result)?.name).toBe("ClassifiedSdkError");
	});

	it("a cold seat that is rate limited too ends the turn instead of seeding every other seat", async () => {
		const store = await storeWithSeats();
		const fake = new FakeSeats(() => "rate_limit");

		const [first] = await failingTurn({ store, fake, session: "s-limited", warm: "warm", turnKey: "turn-1" });

		expect(fake.coldSeeds("s-limited", "warm")).toHaveLength(1);
		expect(blockedTurn(first)).toMatchObject({
			name: "ColdSeedLimitError",
			warmAccount: "warm",
			coldAccount: fake.coldSeeds("s-limited", "warm")[0],
			soonestUnblockAt: undefined,
		});
	});

	it.each([false, true])("goal recovery waits only when seat C is blocked: %s", async (blockedC) => {
		const store = await storeWithSeats();
		await store.modify(PROVIDER, async (credential) => ({
			...emptyCredential(),
			...credential,
			accounts: seats
				.slice(0, 3)
				.map((seat) =>
					seat.name === "warm" || (blockedC && seat.name === "seat-c")
						? { ...seat, blockedUntil: NOW + 4 * HOUR_MS, blockReason: "rate_limit" as const }
						: seat,
				),
		}));
		const fake = new FakeSeats((seat) => (seat === "seat-b" ? "long_limit" : "ok"));
		const input = { store, fake, session: `s-goal-${blockedC}`, warm: "warm", pinned: "seat-b" };
		const result = await tryTurn({ ...input, turnKey: "turn-1" });
		expect(fake.dispatches.map((dispatch) => dispatch.seat)).toEqual(["seat-b"]);
		expect(blockedTurn(result)?.name).toBe("ColdSeedLimitError");
		if (result.ok || !(result.error instanceof Error)) throw new Error("Expected the cold-seat refusal");
		const message: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: PROVIDER,
			model: "claude-sonnet-4-6",
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: result.error.message,
			timestamp: NOW,
		};
		const retryAt = providerRetryAt([message], NOW);
		expect(retryAt).toBe(blockedC ? NOW + 3 * HOUR_MS : undefined);
		expect(blockedTurn(result)?.soonestUnblockAt).toBe(retryAt);
		expect(providerRetryDelayMs(1, retryAt, NOW)).toBe(blockedC ? 3 * HOUR_MS + 1_000 : 0);
		if (!blockedC) {
			expect(await tryTurn({ ...input, turnKey: "turn-2" })).toEqual({ ok: true, seat: "seat-c" });
		}
	});

	it("sessions sharing a spent seat each seed one cold seat, not one per remaining seat", async () => {
		const store = await storeWithSeats();
		// The shared seat is spent for every session (a shared verdict); the other seats are rate limited.
		const fake = new FakeSeats((seat) => (seat === "warm" ? "usage_limit" : "rate_limit"));
		const sessions = ["s-1", "s-2", "s-3"];

		await Promise.all(
			sessions.map((session) => failingTurn({ store, fake, session, warm: "warm", turnKey: `${session}-turn` })),
		);

		for (const session of sessions) expect(fake.coldSeeds(session, "warm")).toHaveLength(1);
	});

	it("a cold seat that serves the turn is the one cold seed, and the turn succeeds there", async () => {
		const store = await storeWithSeats();
		const fake = new FakeSeats((seat) => (seat === "warm" ? "rate_limit" : "ok"));

		const results = await failingTurn({ store, fake, session: "s-moves", warm: "warm", turnKey: "turn-1" });

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ ok: true });
		expect(fake.coldSeeds("s-moves", "warm")).toHaveLength(1);
	});

	it("a later turn may try one cold seat again, and a recovered warm seat always serves", async () => {
		const store = await storeWithSeats();
		let warmDown = true;
		const fake = new FakeSeats((seat) => (seat === "warm" ? (warmDown ? "rate_limit" : "ok") : "rate_limit"));

		await failingTurn({ store, fake, session: "s-next", warm: "warm", turnKey: "turn-1" });
		await tryTurn({ store, fake, session: "s-next", warm: "warm", turnKey: "turn-2" });
		const cold = fake.coldSeeds("s-next", "warm");
		expect(cold).toHaveLength(2);
		expect(new Set(cold).size).toBe(2);

		forgetSessionBlocksFor("warm");
		warmDown = false;
		const recovered = await tryTurn({ store, fake, session: "s-next", warm: "warm", turnKey: "turn-2" });
		expect(recovered).toEqual({ ok: true, seat: "warm" });
	});

	it("a pinned account that fails falls through to the healthy warm seat instead of ending the turn", async () => {
		const store = await storeWithSeats();
		const fake = new FakeSeats((seat) => (seat === "seat-b" ? "rate_limit" : "ok"));

		const result = await tryTurn({
			store,
			fake,
			session: "s-pin",
			warm: "warm",
			pinned: "seat-b",
			turnKey: "turn-1",
		});

		expect(fake.dispatches.map((d) => d.seat)).toEqual(["seat-b", "warm"]);
		expect(result).toEqual({ ok: true, seat: "warm" });
	});

	it("a turn retry may re-run on the cold seat it already sent this prefix to", async () => {
		const store = await storeWithSeats();
		let coldCalls = 0;
		const fake = new FakeSeats((seat) => {
			if (seat === "warm") return "rate_limit";
			coldCalls += 1;
			return coldCalls <= 3 ? "server_error" : "ok";
		});

		const results = await failingTurn({ store, fake, session: "s-rerun", warm: "warm", turnKey: "turn-1" });

		expect(results.at(-1)).toMatchObject({ ok: true });
		expect(new Set(fake.coldSeeds("s-rerun", "warm")).size).toBe(1);
	});

	it("the turn's cold-seat record expires, so a much later retry of the same turn may use another seat", async () => {
		const store = await storeWithSeats();
		let firstCold: string | undefined;
		const fake = new FakeSeats((seat) => {
			if (seat === "warm") return "long_limit";
			firstCold ??= seat;
			return seat === firstCold ? "long_limit" : "ok";
		});

		const first = await tryTurn({ store, fake, session: "s-ttl", warm: "warm", turnKey: "turn-1" });
		expect(blockedTurn(first)?.name).toBe("ColdSeedLimitError");

		const later = await tryTurn({
			store,
			fake,
			session: "s-ttl",
			warm: "warm",
			turnKey: "turn-1",
			at: NOW + 2 * HOUR_MS,
		});
		expect(later).toMatchObject({ ok: true });
		expect(new Set(fake.coldSeeds("s-ttl", "warm")).size).toBe(2);
	});

	it("a warm account that left the pool does not make every account cold", async () => {
		const store = await storeWithSeats();
		const fake = new FakeSeats(() => "rate_limit");

		await tryTurn({ store, fake, session: "s-gone", warm: "removed-account", turnKey: "turn-1" });

		expect(new Set(fake.dispatches.map((d) => d.seat)).size).toBe(seats.length);
	});

	it("a session with no warm seat keeps walking the pool as before", async () => {
		const store = await storeWithSeats();
		const fake = new FakeSeats(() => "rate_limit");
		const accounts = await storedSeats(store);

		await expect(
			(async () => {
				for await (const _ of runFailover<Event>({
					accounts,
					selectFn: (pool) => selectAccount(pool, { sessionId: "s-fresh", now: NOW }),
					runAttempt: fake.attempt("s-fresh"),
					classify: classifySdkError,
					store,
					providerId: PROVIDER,
					now: () => NOW,
					sleep: async () => {},
					sessionKey: "s-fresh",
				}));
			})(),
		).rejects.toThrow();
		expect(new Set(fake.dispatches.map((d) => d.seat)).size).toBe(seats.length);
	});
});
