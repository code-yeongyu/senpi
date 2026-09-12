import { type CredentialStore, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/claude-sdk-oauth/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/claude-sdk-oauth/failover.ts";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const fableUsageCredits =
	"Claude Code returned an error result: Fable 5 requires usage credits. Run /usage-credits to continue or switch models with /model.";
const accountPool: AccountSlot[] = [
	{ name: "alpha", refresh: "r-alpha", access: "a-alpha", expires: 1, source: "login" },
	{ name: "bravo", refresh: "r-bravo", access: "a-bravo", expires: 1, source: "login" },
];
const now = 10_000;

async function storeWithAccounts(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("claude-sdk-oauth", async () =>
		accountPool.reduce<ClaudeSdkOauthCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("regression #709: Claude SDK OAuth entitlement fallback", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("advances the retry-fallback chain to the next model after a Fable usage-credit error", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 60_000, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: fableUsageCredits }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(
			harness.events
				.filter(
					(event) =>
						event.type === "retry_fallback_applied" ||
						event.type === "auto_retry_start" ||
						event.type === "retry_fallback_succeeded",
				)
				.map((event) => {
					if (event.type === "retry_fallback_applied") return `${event.type}:${event.reason}`;
					if (event.type === "auto_retry_start") return `${event.type}:${event.delayMs}`;
					return event.type;
				}),
		).toEqual(["retry_fallback_applied:hard-error", "auto_retry_start:0", "retry_fallback_succeeded"]);
	});

	it("throws the usage-credit failure without blocking the OAuth account slot", async () => {
		expect(classifySdkError(fableUsageCredits).retryable).toBe(false);
		expect(classifySdkError(fableUsageCredits).kind).not.toBe("rate_limit");
		const store = await storeWithAccounts();
		const attempts: string[] = [];
		const stream = runFailover({
			accounts: accountPool,
			selectFn: (pool) => selectAccount(pool, { sessionId: "entitlement", now }),
			runAttempt: async function* (slot) {
				attempts.push(slot.name);
				if (attempts.length === 1) throw new Error(fableUsageCredits);
				yield { type: "done", value: slot.name };
			},
			classify: classifySdkError,
			store,
			providerId: "claude-sdk-oauth",
			now: () => now,
		});
		await expect(collect(stream)).rejects.toMatchObject({
			name: "ClassifiedSdkError",
			classification: { retryable: false },
		});
		expect(attempts).toHaveLength(1);
		const credential = (await store.read("claude-sdk-oauth")) as ClaudeSdkOauthCredential;
		for (const account of credential.accounts ?? []) {
			expect(account.blockedUntil).toBeUndefined();
			expect(account.blockReason).toBeUndefined();
		}
	});
});
