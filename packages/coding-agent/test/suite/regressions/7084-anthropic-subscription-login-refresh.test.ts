import type { OAuthAuth } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	listAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";

function fakeFlow(credential: { access: string; refresh: string; expires: number }): OAuthAuth {
	return {
		name: "fake",
		async login() {
			return { type: "oauth", ...credential };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

function slot(overrides: Partial<AccountSlot> & { name: string }): AccountSlot {
	return {
		access: `${overrides.name}-access`,
		refresh: `${overrides.name}-refresh`,
		expires: Date.now() + 3_600_000,
		source: "login",
		...overrides,
	};
}

function credentialWith(
	slots: AccountSlot[],
	extra?: Partial<AnthropicSubscriptionCredential>,
): AnthropicSubscriptionCredential {
	return { ...emptyCredential(), accounts: slots, ...extra };
}

const fresh = { access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
const blockedDefault = slot({ name: "default", blockReason: "auth_error", expires: Date.now() - 1_000 });

describe("re-login refreshes the dead slot instead of appending (omo#7084)", () => {
	it("a single auth_error-blocked slot is refreshed in place and selectable again", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.access).toBe("new-access");
		expect(slots[0]?.refresh).toBe("new-refresh");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(slots[0]?.blockedUntil).toBeUndefined();
		expect(selectAccount(slots).name).toBe("default");
	});

	it("typing the existing name refreshes it instead of throwing 'already exists'", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "default" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.access).toBe("new-access");
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("preserves the refreshed slot's displayName and leaves sibling slots untouched", async () => {
		const personal = slot({ name: "personal" });
		const dead = slot({ name: "default", blockReason: "auth_error", displayName: "Work" });
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([dead, personal]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "default" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default", "personal"]);
		expect(slots[0]?.displayName).toBe("Work");
		expect(slots[0]?.access).toBe("new-access");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(slots[1]).toEqual(personal);
	});

	it("a blank re-login in a multi-account pool targets the single auth_error-blocked slot", async () => {
		const personal = slot({ name: "personal" });
		const current = credentialWith([blockedDefault, personal], { pinned: "personal" });
		const config = createOAuthConfig({
			readCurrent: async () => current,
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default", "personal"]);
		expect(slots[0]?.access).toBe("new-access");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(slots[1]).toEqual(personal);
		expect((credential as AnthropicSubscriptionCredential).pinned).toBe("personal");
	});

	it("a blank re-login with no blocked slot appends instead of overwriting the newest slot", async () => {
		const work = slot({ name: "work" });
		const personal = slot({ name: "personal" });
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([work, personal]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["work", "personal", "account-3"]);
		expect(slots[0]?.access).toBe("work-access");
		expect(slots[1]?.access).toBe("personal-access");
	});

	it("an explicit new name still appends a separate account and keeps the sibling block", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default", "work"]);
		expect(slots[0]?.blockReason).toBe("auth_error");
		expect(slots[1]?.access).toBe("new-access");
	});

	it("a headless re-login with a single slot refreshes it in place", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({});
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.access).toBe("new-access");
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("a headless re-login with several working slots appends (no identity guessing)", async () => {
		const work = slot({ name: "work" });
		const personal = slot({ name: "personal" });
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([work, personal]),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({});
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["work", "personal", "account-3"]);
		expect(slots[0]?.access).toBe("work-access");
		expect(slots[1]?.access).toBe("personal-access");
	});
});

describe("anthropic import moves the grant instead of forking it (omo#7084)", () => {
	it("accepting the import removes the anthropic provider credential", async () => {
		let removed = 0;
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			removeAnthropicCredential: async () => {
				removed++;
			},
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "y" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["imported-anthropic"]);
		expect(slots[0]?.source).toBe("import");
		expect(removed).toBe(1);
	});

	it("declining the import keeps the anthropic credential in place", async () => {
		let removed = 0;
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			removeAnthropicCredential: async () => {
				removed++;
			},
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "n" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(removed).toBe(0);
	});
});

describe("AllAccountsBlockedError names the dominant block reason (omo#8383)", () => {
	it("carries auth_error when any slot is auth-blocked", () => {
		const rateLimited = slot({ name: "rl", blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" });
		let caught: unknown;
		try {
			selectAccount([blockedDefault, rateLimited]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBe("auth_error");
	});

	it("carries no auth reason for purely timed blocks", () => {
		const rateLimited = slot({ name: "rl", blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" });
		let caught: unknown;
		try {
			selectAccount([rateLimited]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBeUndefined();
	});
});
