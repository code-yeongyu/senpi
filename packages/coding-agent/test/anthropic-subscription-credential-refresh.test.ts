import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { classifySdkError } from "../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { ClassifiedSdkError, runFailover } from "../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";

const PROVIDER = "anthropic-subscription";
const REVOKED = "Failed to authenticate. API Error: 401 OAuth access token has been revoked. (authentication_failed)";
const now = 10_000;

type Done = { type: "done"; value: string };

const original: AccountSlot = { name: "default", access: "a-old", refresh: "r-old", expires: 1, source: "login" };
const rotated = { access: "a-new", refresh: "r-new", expires: 2 };

async function storeWith(slot: AccountSlot): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () => addAccount(emptyCredential(), slot));
	return store;
}

async function storedSlot(store: CredentialStore): Promise<AccountSlot | undefined> {
	const credential = (await store.read(PROVIDER)) as AnthropicSubscriptionCredential;
	return credential.accounts?.[0];
}

async function rotateStoredToken(store: CredentialStore): Promise<void> {
	await store.modify(PROVIDER, async (current) => {
		const credential = current as AnthropicSubscriptionCredential;
		return { ...credential, accounts: credential.accounts?.map((slot) => ({ ...slot, ...rotated })) };
	});
}

function failover(
	store: CredentialStore,
	runAttempt: (slot: AccountSlot) => AsyncIterable<Done> | Promise<AsyncIterable<Done>>,
) {
	return runFailover<Done>({
		accounts: [{ ...original }],
		selectFn: (pool) => pool[0]!,
		runAttempt,
		classify: classifySdkError,
		store,
		providerId: PROVIDER,
		now: () => now,
	});
}

async function collect(iterable: AsyncIterable<Done>): Promise<Done[]> {
	const events: Done[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("anthropic-subscription auth blocks follow the rejected token, not the account", () => {
	it("does not auth-block a slot whose token was refreshed meanwhile, and retries it on the stored token", async () => {
		const store = await storeWith(original);
		const used: string[] = [];
		const events = await collect(
			failover(store, async function* (slot) {
				used.push(slot.access);
				if (used.length === 1) {
					await rotateStoredToken(store);
					throw new Error(REVOKED);
				}
				yield { type: "done", value: slot.access };
			}),
		);

		expect(used).toEqual(["a-old", "a-new"]);
		expect(events).toEqual([{ type: "done", value: "a-new" }]);
		const stored = await storedSlot(store);
		expect(stored).toMatchObject(rotated);
		expect(stored?.blockReason).toBeUndefined();
	});

	it("does not auth-block when an in-process refresh rewrites the shared slot object mid-request", async () => {
		const store = await storeWith(original);
		const shared: AccountSlot = { ...original };
		const used: string[] = [];
		const stream = runFailover<Done>({
			accounts: [shared],
			selectFn: (pool) => pool[0]!,
			runAttempt: async function* (slot) {
				used.push(slot.access);
				if (used.length === 1) {
					Object.assign(shared, rotated);
					await rotateStoredToken(store);
					throw new Error(REVOKED);
				}
				yield { type: "done", value: slot.access };
			},
			classify: classifySdkError,
			store,
			providerId: PROVIDER,
			now: () => now,
		});

		expect(await collect(stream)).toEqual([{ type: "done", value: "a-new" }]);
		expect(used).toEqual(["a-old", "a-new"]);
		expect((await storedSlot(store))?.blockReason).toBeUndefined();
	});

	it("still auth-blocks when the stored token itself is rejected", async () => {
		const store = await storeWith(original);
		const used: string[] = [];
		const stream = failover(store, async (slot) => {
			used.push(slot.access);
			if (used.length === 1) await rotateStoredToken(store);
			throw new Error(REVOKED);
		});

		await expect(collect(stream)).rejects.toBeInstanceOf(ClassifiedSdkError);
		expect(used).toEqual(["a-old", "a-new"]);
		expect(await storedSlot(store)).toMatchObject({ ...rotated, blockReason: "auth_error" });
	});
});

describe("anthropic-subscription resident sessions follow the account's current token", () => {
	const fingerprint = { systemPromptHash: "prompt", toolsetHash: "tools" };
	function decide(entryDigest: string | undefined, inputDigest: string | undefined) {
		const input: ContinuityDecisionInput = {
			entry: {
				sdkSessionId: "sdk-1",
				accountName: "default",
				modelId: "claude-opus-5-5",
				...fingerprint,
				sentCount: 2,
				sentHashes: ["h1", "h2"],
				lastAssistantUuid: "uuid-a2",
				assistantUuidByIndex: new Map([[2, "uuid-a2"]]),
				pendingForkReason: null,
				credentialDigest: entryDigest,
			},
			binding: undefined,
			currentHashes: ["h1", "h2", "h3"],
			accountName: "default",
			modelId: "claude-opus-5-5",
			fingerprint,
			transcriptAvailable: true,
			crossAccountResumeSupported: true,
			credentialDigest: inputDigest,
		};
		return decideNativeContinuity(input);
	}

	it("resumes the lineage in a fresh subprocess when the token was refreshed", () => {
		expect(decide("old", "new")).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 2,
			reason: "credential_refreshed",
		});
	});

	it("keeps sending deltas while the token is unchanged or unknown", () => {
		expect(decide("same", "same")).toEqual({ kind: "delta", from: 2 });
		expect(decide(undefined, "new")).toEqual({ kind: "delta", from: 2 });
		expect(decide("old", undefined)).toEqual({ kind: "delta", from: 2 });
	});
});
