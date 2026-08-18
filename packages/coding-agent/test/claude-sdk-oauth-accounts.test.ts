import { type Credential, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	addAccount,
	assertSentinelInvariant,
	type ClaudeSdkOauthCredential,
	emptyCredential,
	envSlots,
	listAccounts,
	pinAccount,
	refreshSlot,
	removeAccount,
	SENTINEL_OAUTH_FIELDS,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";

function makeStore(initial?: Credential): CredentialStore & { written: Credential[] } {
	let current = initial;
	const written: Credential[] = [];
	return {
		written,
		async read() {
			return current;
		},
		async list() {
			return current ? [{ providerId: "claude-sdk-oauth", type: current.type }] : [];
		},
		async delete() {
			current = undefined;
		},
		async modify(_provider, fn) {
			const next = await fn(current);
			current = next;
			if (next) written.push(next);
			return next;
		},
	};
}

const slotA = {
	name: "default",
	refresh: "rA",
	access: "aA",
	expires: Date.now() + 60_000,
	source: "login" as const,
};

describe("account slots", () => {
	it("creates an empty credential with sentinel top-level fields", () => {
		const cred = emptyCredential();
		expect(cred.type).toBe("oauth");
		expect(cred.access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(cred.refresh).toBe(SENTINEL_OAUTH_FIELDS.refresh);
		expect(cred.expires).toBe(SENTINEL_OAUTH_FIELDS.expires);
		expect(listAccounts(cred)).toEqual([]);
	});

	it("adds, lists, pins and removes accounts", () => {
		let cred = emptyCredential();
		cred = addAccount(cred, slotA);
		cred = addAccount(cred, { ...slotA, name: "work" });
		expect(listAccounts(cred).map((a) => a.name)).toEqual(["default", "work"]);
		cred = pinAccount(cred, "work");
		expect(cred.pinned).toBe("work");
		cred = removeAccount(cred, "default");
		expect(listAccounts(cred).map((a) => a.name)).toEqual(["work"]);
	});

	it("rejects duplicate account names", () => {
		const cred = addAccount(emptyCredential(), slotA);
		expect(() => addAccount(cred, slotA)).toThrowError(/duplicate|already exists/i);
	});

	it("keeps the sentinel invariant after every operation", () => {
		let cred = addAccount(emptyCredential(), slotA);
		cred = pinAccount(cred, "default");
		cred = removeAccount(cred, "default");
		expect(() => assertSentinelInvariant(cred)).not.toThrow();
		expect(cred.access).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("hydrates env slots from the live environment without persisting tokens", () => {
		const env = (name: string) => ({ CLAUDE_CODE_OAUTH_TOKEN: "tok1", CLAUDE_CODE_OAUTH_TOKEN_2: "tok2" })[name];
		const slots = envSlots(env);
		expect(slots.map((s) => s.name)).toEqual(["env", "env-2"]);
		expect(slots.every((s) => s.source === "env")).toBe(true);
		const serialized = JSON.stringify(slots[0]);
		expect(serialized).not.toContain("tok1");
	});

	it("persists non-secret env slot state and rehydrates after restart", () => {
		let cred = emptyCredential();
		cred = { ...cred, slotState: { env: { blockedUntil: 123, blockReason: "rate_limit" } } };
		const env = (name: string) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? "tok1" : undefined);
		const merged = listAccounts(cred, env);
		expect(merged[0].blockedUntil).toBe(123);
		expect(JSON.stringify(cred)).not.toContain("tok1");
	});

	it("refreshSlot updates only its slot under the store lock", async () => {
		const store = makeStore(addAccount(emptyCredential(), { ...slotA, expires: Date.now() - 1000 }));
		const signal = new AbortController().signal;
		let receivedSignal: AbortSignal | undefined;
		const refresher = async (refresh: string, refreshSignal: AbortSignal) => {
			receivedSignal = refreshSignal;
			return {
				refresh: `${refresh}-new`,
				access: "aA-new",
				expires: Date.now() + 120_000,
			};
		};
		const next = await refreshSlot(store, "claude-sdk-oauth", "default", refresher, signal);
		const slot = listAccounts(next as ClaudeSdkOauthCredential)[0];
		expect(receivedSignal).toBe(signal);
		expect(slot.access).toBe("aA-new");
		expect(slot.refresh).toBe("rA-new");
		const stored = (await store.read("claude-sdk-oauth")) as ClaudeSdkOauthCredential;
		expect(stored.access).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("concurrent refreshSlot calls do not double-refresh", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("claude-sdk-oauth", async () =>
			addAccount(emptyCredential(), { ...slotA, expires: Date.now() - 1000 }),
		);
		let calls = 0;
		let gate: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			gate = resolve;
		});
		const refresher = async (refresh: string) => {
			calls++;
			await barrier;
			return { refresh, access: `a-${calls}`, expires: Date.now() + 60_000 };
		};
		const signal = new AbortController().signal;
		const first = refreshSlot(store, "claude-sdk-oauth", "default", refresher, signal);
		const second = refreshSlot(store, "claude-sdk-oauth", "default", refresher, signal);
		gate?.();
		await Promise.all([first, second]);
		expect(calls).toBe(1);
	});
});
