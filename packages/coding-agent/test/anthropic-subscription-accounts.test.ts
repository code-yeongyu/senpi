import { describe, expect, it } from "vitest";
import {
	type AnthropicSubscriptionCredential,
	addAccount,
	assertSentinelInvariant,
	emptyCredential,
	envSlots,
	listAccounts,
	pinAccount,
	removeAccount,
	SENTINEL_OAUTH_FIELDS,
} from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { cliSlot } from "./support/claude-cli-test-slots.ts";

const slotA = cliSlot("default");

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
		cred = addAccount(cred, cliSlot("work"));
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

	it("never lists a stored slot that holds tokens, such as one the retired login wrote (senpi#4436)", () => {
		const stored = {
			...emptyCredential(),
			accounts: [
				slotA,
				{ name: "old", access: "aA", refresh: "rA", expires: 1, source: "login" },
				{
					name: "login-2",
					access: SENTINEL_OAUTH_FIELDS.access,
					refresh: SENTINEL_OAUTH_FIELDS.refresh,
					expires: SENTINEL_OAUTH_FIELDS.expires,
					source: "login",
				},
			],
		} as unknown as AnthropicSubscriptionCredential;
		expect(listAccounts(stored).map((account) => account.name)).toEqual(["default"]);
	});
});
