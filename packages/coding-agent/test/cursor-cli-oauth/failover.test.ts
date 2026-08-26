import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	addAccount,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	AllCursorAccountsBlockedError,
	rendezvousOrder,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/affinity.ts";
import {
	CursorCliFailoverError,
	type CursorCliFailoverNotice,
	runCursorCliFailover,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/failover.ts";

const providerId = "cursor-cli-oauth";
const now = 10_000;
const accountPool: CursorCliAccountSlot[] = [
	{ name: "alpha", access: "a-alpha", refresh: "r-alpha", expires: 50_000, source: "login" },
	{ name: "bravo", access: "a-bravo", refresh: "r-bravo", expires: 50_000, source: "login" },
	{ name: "charlie", access: "a-charlie", refresh: "r-charlie", expires: 50_000, source: "login" },
];

type AttemptEvent = { type: "assistant_delta"; delta: string } | { type: "done" };

type OutputEvent = AttemptEvent | CursorCliFailoverNotice;

async function makeStore(accounts: readonly CursorCliAccountSlot[] = accountPool): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () =>
		accounts.reduce<CursorCliOauthCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function collect(iterable: AsyncIterable<OutputEvent>): Promise<OutputEvent[]> {
	const events: OutputEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

function assistant(delta: string): AttemptEvent {
	return { type: "assistant_delta", delta };
}

function failoverOptions(store: InMemoryCredentialStore, sessionId: string) {
	return {
		store,
		providerId,
		affinity: { sessionId, now },
		now: () => now,
		isVisibleAssistantDelta: (event: AttemptEvent) => event.type === "assistant_delta" && event.delta.length > 0,
	};
}

async function storedCredential(store: InMemoryCredentialStore): Promise<CursorCliOauthCredential> {
	return (await store.read(providerId)) as CursorCliOauthCredential;
}

describe("Cursor CLI OAuth account failover", () => {
	it("rotates a pre-delta rate limit in HRW order, starts a fresh chat, and emits a context-loss notice", async () => {
		const store = await makeStore();
		const sessionId = "pre-delta";
		const expected = rendezvousOrder(sessionId, accountPool).map((account) => account.name);
		const attempts: Array<{ name: string; freshChat: boolean }> = [];

		const events = await collect(
			runCursorCliFailover<AttemptEvent>({
				...failoverOptions(store, sessionId),
				runAttempt: async function* (account, attempt) {
					attempts.push({ name: account.name, freshChat: attempt.freshChat });
					if (attempts.length === 1) throw { stderr: "HTTP 429 rate limit retry-after-ms: 2500" };
					yield assistant(`answer from ${account.name}`);
				},
			}),
		);

		expect(attempts).toEqual([
			{ name: expected[0], freshChat: false },
			{ name: expected[1], freshChat: true },
		]);
		expect(events[0]).toMatchObject({
			type: "cursor_account_changed",
			fromAccount: expected[0],
			toAccount: expected[1],
			freshChat: true,
			priorContextCarriedOver: false,
		});
		expect((events[0] as CursorCliFailoverNotice).message).toContain("account changed");
		expect((events[0] as CursorCliFailoverNotice).message).toContain("prior context was not carried over");
		expect(events[1]).toEqual(assistant(`answer from ${expected[1]}`));
	});

	it("surfaces a post-delta rate limit without rotating", async () => {
		const store = await makeStore();
		const attempts: string[] = [];
		const emitted: OutputEvent[] = [];
		const stream = runCursorCliFailover<AttemptEvent>({
			...failoverOptions(store, "post-delta"),
			runAttempt: async function* (account) {
				attempts.push(account.name);
				yield assistant("partial");
				throw { stderr: "HTTP 429 too many requests" };
			},
		});

		await expect(
			(async () => {
				for await (const event of stream) emitted.push(event);
			})(),
		).rejects.toMatchObject({
			name: "CursorCliFailoverError",
			classification: { kind: "rate_limit" },
			visibleAssistantDeltaEmitted: true,
		});
		expect(attempts).toHaveLength(1);
		expect(emitted).toEqual([assistant("partial")]);
	});

	it("blocks auth errors until re-login and tries the next account", async () => {
		const store = await makeStore();
		const attempts: string[] = [];
		await collect(
			runCursorCliFailover<AttemptEvent>({
				...failoverOptions(store, "auth-error"),
				runAttempt: async function* (account) {
					attempts.push(account.name);
					if (attempts.length === 1) throw { resultEvent: { result: "HTTP 401 Unauthorized" } };
					yield assistant("recovered");
				},
			}),
		);

		const credential = await storedCredential(store);
		const blocked = credential.accounts?.find((account) => account.name === attempts[0]);
		expect(blocked).toMatchObject({ blockReason: "auth_error" });
		expect(blocked?.blockedUntil).toBeUndefined();
		expect(attempts).toHaveLength(2);
	});

	it("raises AllCursorAccountsBlockedError when no account is available", async () => {
		const store = await makeStore(
			accountPool.map((account, index) => ({
				...account,
				...(index === 0
					? { blockReason: "auth_error" as const }
					: { blockReason: "rate_limit" as const, blockedUntil: now + index * 1_000 }),
			})),
		);
		let attempts = 0;
		const stream = runCursorCliFailover<AttemptEvent>({
			...failoverOptions(store, "all-blocked"),
			runAttempt: async function* () {
				attempts += 1;
				yield assistant("unreachable");
			},
		});

		await expect(collect(stream)).rejects.toBeInstanceOf(AllCursorAccountsBlockedError);
		expect(attempts).toBe(0);
	});

	it.each([
		["invalid_model", { resultEvent: { result: "Invalid model value: bogus" } }],
		["binary_missing", { thrown: { kind: "binary_missing", message: "missing" } }],
		["malformed_stream", { thrown: { kind: "malformed_stream", message: "bad json" } }],
		["other", { thrown: new Error("unknown failure") }],
	] as const)("never rotates non-retryable %s failures", async (kind, failure) => {
		const store = await makeStore();
		const attempts: string[] = [];
		const stream = runCursorCliFailover<AttemptEvent>({
			...failoverOptions(store, `non-retryable-${kind}`),
			runAttempt: async function* (account) {
				attempts.push(account.name);
				yield* [] as AttemptEvent[];
				throw failure;
			},
		});

		await expect(collect(stream)).rejects.toMatchObject({
			name: "CursorCliFailoverError",
			classification: { kind },
		});
		expect(attempts).toHaveLength(1);
	});

	it.each([
		["server hint", "HTTP 429 rate limit retry-after-ms: 2500", 2_500],
		["default", "HTTP 429 rate limit", 60_000],
		["48 hour cap", "HTTP 429 rate limit retry-after: 200000", 48 * 60 * 60 * 1_000],
	] as const)("honors the %s rate-limit block duration", async (_label, stderr, expectedBlockMs) => {
		const store = await makeStore();
		const attempts: string[] = [];
		await collect(
			runCursorCliFailover<AttemptEvent>({
				...failoverOptions(store, `duration-${expectedBlockMs}`),
				runAttempt: async function* (account) {
					attempts.push(account.name);
					if (attempts.length === 1) throw { stderr };
					yield assistant("ok");
				},
			}),
		);

		const credential = await storedCredential(store);
		expect(credential.accounts?.find((account) => account.name === attempts[0])).toMatchObject({
			blockReason: "rate_limit",
			blockedUntil: now + expectedBlockMs,
		});
	});

	it("settles the failed attempt stream before starting the replacement", async () => {
		const store = await makeStore();
		let firstSettled = false;
		let attempts = 0;
		await collect(
			runCursorCliFailover<AttemptEvent>({
				...failoverOptions(store, "settlement"),
				runAttempt: async function* () {
					attempts += 1;
					if (attempts === 1) {
						try {
							throw { stderr: "HTTP 429 rate limit" };
						} finally {
							firstSettled = true;
						}
					}
					expect(firstSettled).toBe(true);
					yield assistant("settled");
				},
			}),
		);
	});

	it("re-reads concurrent slot blocks before selecting a replacement", async () => {
		const store = await makeStore(accountPool.slice(0, 2));
		let firstAccount = "";
		const stream = runCursorCliFailover<AttemptEvent>({
			...failoverOptions(store, "stale-state"),
			runAttempt: async function* (account) {
				firstAccount = account.name;
				await store.modify(providerId, async (current) => {
					const credential = current as CursorCliOauthCredential;
					return {
						...credential,
						accounts: credential.accounts?.map((slot) =>
							slot.name === account.name ? slot : { ...slot, blockReason: "auth_error" as const },
						),
					};
				});
				throw { stderr: "HTTP 429 rate limit" };
			},
		});

		await expect(collect(stream)).rejects.toBeInstanceOf(AllCursorAccountsBlockedError);
		expect(firstAccount).not.toBe("");
	});

	it("does not treat a failover notice without assistant text as a successful retry", async () => {
		const store = await makeStore(accountPool.slice(0, 2));
		let attempts = 0;
		const emitted: OutputEvent[] = [];
		const stream = runCursorCliFailover<AttemptEvent>({
			...failoverOptions(store, "notice-only"),
			runAttempt: async function* () {
				attempts += 1;
				if (attempts === 1) throw { stderr: "HTTP 429 rate limit" };
				yield { type: "done" };
			},
		});

		await expect(
			(async () => {
				for await (const event of stream) emitted.push(event);
			})(),
		).rejects.toBeInstanceOf(CursorCliFailoverError);
		expect(emitted.some((event) => event.type === "cursor_account_changed")).toBe(true);
		expect(emitted.some((event) => event.type === "assistant_delta")).toBe(false);
	});
});
