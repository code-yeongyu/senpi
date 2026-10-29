import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { appendLoginSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import {
	type AnthropicSubscriptionCredential,
	emptyCredential as emptyAnthropicCredential,
	listAccounts as listAnthropicAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig as createAnthropicOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import {
	type CursorCliOauthCredential,
	emptyCredential as emptyCursorCredential,
} from "../../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { createCursorCliOauthConfig } from "../../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";

// senpi#3619: a blank or headless login next to ONE healthy account must add a
// second account. Only an auth_error-blocked slot (or a slot the user names) is
// a recovery target. Every OAuth login path that stores accounts is swept here.

type Slot = { name: string; access: string; refresh: string; expires: number };

const EXPIRES = 4_000_000_000_000;
const healthy: Slot & { source: "login" } = {
	name: "default",
	access: "first-access",
	refresh: "first-refresh",
	expires: EXPIRES,
	source: "login",
};
const second = { access: "second-access", refresh: "second-refresh", expires: EXPIRES + 1 };

function fakeFlow(): OAuthAuth {
	return {
		name: "fake",
		async login(): Promise<OAuthCredential> {
			return { type: "oauth", ...second };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

function slotsOf(credential: Credential): Slot[] {
	const accounts = (credential as PooledCredential).accounts;
	if (Array.isArray(accounts)) return accounts as Slot[];
	const flat = credential as OAuthCredential;
	return [{ name: "default", access: flat.access, refresh: flat.refresh, expires: flat.expires }];
}

type Row = {
	provider: string;
	mode: "blank" | "headless";
	login(): Promise<Credential>;
};

const anthropicStored = (): AnthropicSubscriptionCredential => ({ ...emptyAnthropicCredential(), accounts: [healthy] });

async function anthropicLogin(mode: Row["mode"]): Promise<Credential> {
	const stored = anthropicStored();
	const config = createAnthropicOAuthConfig({ readCurrent: async () => stored, loginFlow: fakeFlow() });
	const result = await config.login(mode === "blank" ? { onPrompt: async () => "" } : {});
	return appendLoginSlot(stored, result as AnthropicSubscriptionCredential);
}

async function cursorLogin(): Promise<Credential> {
	const stored: CursorCliOauthCredential = { ...emptyCursorCredential(), accounts: [healthy] };
	const config = createCursorCliOauthConfig({
		readCurrent: async () => stored,
		readSettings: () => ({ enabled: true, executablePath: undefined }),
		resolveExecutable: () => "/usr/local/bin/cursor-agent",
		loadOAuth: async () => fakeFlow(),
	});
	const result = await config.login({
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	});
	return appendLoginSlot(stored as PooledCredential, result as Credential);
}

async function pooledLogin(): Promise<Credential> {
	// Providers without their own account store (ChatGPT, Copilot, ...) persist a flat login.
	const stored: PooledCredential = {
		type: "oauth",
		access: healthy.access,
		refresh: healthy.refresh,
		expires: healthy.expires,
	};
	return appendLoginSlot(stored, { type: "oauth", ...second });
}

const rows: Row[] = [
	{ provider: "anthropic-subscription", mode: "blank", login: () => anthropicLogin("blank") },
	{ provider: "anthropic-subscription", mode: "headless", login: () => anthropicLogin("headless") },
	{ provider: "cursor-cli-oauth", mode: "blank", login: cursorLogin },
	{ provider: "generic credential pool", mode: "headless", login: pooledLogin },
];

describe("a login next to one healthy account adds a second account (senpi#3619)", () => {
	it.each(rows)("$provider, $mode login: two accounts, the first unchanged", async ({ login }) => {
		const slots = slotsOf(await login());
		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({
			name: "default",
			access: healthy.access,
			refresh: healthy.refresh,
			expires: healthy.expires,
		});
		expect(slots[1]).toMatchObject(second);
		expect(slots[1]?.name).not.toBe("default");
	});
});

describe("the omo#7084 recovery still refreshes a lone auth-blocked Claude account", () => {
	it.each(["blank", "headless"] as const)("%s login refreshes the blocked slot in place", async (mode) => {
		const blocked = { ...healthy, blockReason: "auth_error" as const, blockedUntil: Date.now() + 60_000 };
		const stored: AnthropicSubscriptionCredential = { ...emptyAnthropicCredential(), accounts: [blocked] };
		const config = createAnthropicOAuthConfig({ readCurrent: async () => stored, loginFlow: fakeFlow() });
		const result = await config.login(mode === "blank" ? { onPrompt: async () => "" } : {});
		const slots = listAnthropicAccounts(appendLoginSlot(stored, result as AnthropicSubscriptionCredential) as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots[0]).toMatchObject(second);
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("typing the healthy slot's name still refreshes it in place", async () => {
		const stored = anthropicStored();
		const config = createAnthropicOAuthConfig({ readCurrent: async () => stored, loginFlow: fakeFlow() });
		const result = await config.login({ onPrompt: async () => "default" });
		const slots = listAnthropicAccounts(appendLoginSlot(stored, result as AnthropicSubscriptionCredential) as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots[0]).toMatchObject(second);
	});
});
