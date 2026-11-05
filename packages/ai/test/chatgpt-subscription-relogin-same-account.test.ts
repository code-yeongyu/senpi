import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import {
	appendLoginSlot,
	listSlots,
	type PooledCredential,
	ReauthorizeAccountMismatchError,
} from "../src/auth/pool/slots.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { chatgptSubscriptionProvider } from "../src/providers/chatgpt-subscription.ts";

// Synthetic Codex access tokens: only the claims the identity reads, never a real token.
function jwt(auth: Record<string, string>, tag: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": auth, jti: tag })}.sig`;
}

const personA = { chatgpt_account_id: "ws-1", chatgpt_account_user_id: "user-a__ws-1", chatgpt_user_id: "user-a" };
const personB = { chatgpt_account_id: "ws-1", chatgpt_account_user_id: "user-b__ws-1", chatgpt_user_id: "user-b" };

function login(auth: Record<string, string>, tag: string, expires: number): OAuthCredential {
	return {
		type: "oauth",
		access: jwt(auth, tag),
		refresh: `refresh-${tag}`,
		expires,
		accountId: auth.chatgpt_account_id,
	};
}

const shippedOAuth = chatgptSubscriptionProvider().auth.oauth;
if (!shippedOAuth) throw new Error("the ChatGPT subscription provider has no OAuth auth");
const identity = shippedOAuth.accountIdentity;

describe("ChatGPT account identity (omo#9633)", () => {
	test("the same person in the same workspace has one identity across tokens", () => {
		expect(identity?.(login(personA, "old", 1))).toBeDefined();
		expect(identity?.(login(personA, "old", 1))).toBe(identity?.(login(personA, "new", 2)));
	});

	test("two members of one Team workspace are different accounts", () => {
		expect(identity?.(login(personA, "a", 1))).not.toBe(identity?.(login(personB, "b", 1)));
	});

	test("one person in two workspaces is two accounts; without a per-member claim the user id is scoped to the workspace", () => {
		const ws1 = { chatgpt_account_id: "ws-1", chatgpt_user_id: "user-a" };
		const ws2 = { chatgpt_account_id: "ws-2", chatgpt_user_id: "user-a" };
		expect(identity?.(login(ws1, "1", 1))).toBeDefined();
		expect(identity?.(login(ws1, "1", 1))).not.toBe(identity?.(login(ws2, "2", 1)));
	});

	test("a token naming only the workspace has no identity", () => {
		expect(identity?.(login({ chatgpt_account_id: "ws-1" }, "x", 1))).toBeUndefined();
		expect(identity?.({ access: "not-a-jwt" })).toBeUndefined();
	});
});

describe("a ChatGPT re-login of a saved account replaces it instead of appending (omo#9633)", () => {
	const options = { accountIdentity: identity };

	test("an SIWC login whose issuer/subject/client tuple differs never replaces an SIWC slot by token identity", () => {
		const siwc = { route: "siwc" as const, issuer: "https://auth.openai.com", subject: "sub-a" };
		const saved = { ...login(personA, "old", 1), ...siwc, clientId: "client-1" };
		const stored: PooledCredential = { ...saved, accounts: [{ ...saved, name: "default", source: "login" }] };
		const fresh = { ...login(personA, "new", 2), ...siwc, clientId: "client-2" };
		const slots = listSlots(appendLoginSlot(stored, fresh, undefined, options) as PooledCredential);
		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({ name: "default", refresh: "refresh-old", clientId: "client-1" });
		expect(slots[1]).toMatchObject({ refresh: "refresh-new", clientId: "client-2" });
	});

	test("a same-route re-login keeps the login's account fields on the replaced slot", () => {
		const siwc = {
			route: "siwc" as const,
			clientId: "client-1",
			issuer: "https://auth.openai.com",
			subject: "sub-a",
		};
		const saved = { ...login(personA, "old", 1), ...siwc };
		const stored: PooledCredential = { ...saved, accounts: [{ ...saved, name: "default", source: "login" }] };
		const slots = listSlots(
			appendLoginSlot(stored, { ...login(personA, "new", 2), ...siwc }, undefined, options) as PooledCredential,
		);
		expect(slots).toHaveLength(1);
		expect(slots[0]).toMatchObject({ name: "default", refresh: "refresh-new", ...siwc });
	});

	test.each([
		["an SIWC login does not replace a legacy Codex slot", undefined, "siwc"],
		["a legacy login does not replace an SIWC slot", "siwc", undefined],
	] as const)("%s of the same person (routes never cross)", (_name, storedRoute, loginRoute) => {
		const saved = { ...login(personA, "old", 1), ...(storedRoute ? { route: storedRoute } : {}) };
		const stored: PooledCredential = { ...saved, accounts: [{ ...saved, name: "default", source: "login" }] };
		const fresh = { ...login(personA, "new", 2), ...(loginRoute ? { route: loginRoute } : {}) };
		const next = appendLoginSlot(stored, fresh, undefined, options) as PooledCredential;
		const slots = listSlots(next);
		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({ name: "default", refresh: "refresh-old", expires: 1 });
		expect(slots[0]?.route).toBe(storedRoute);
		expect(slots[1]).toMatchObject({ refresh: "refresh-new", expires: 2 });
		expect(slots[1]?.route).toBe(loginRoute);
	});

	test("a flat saved account is rewritten in place", () => {
		const next = appendLoginSlot(login(personA, "old", 1), login(personA, "new", 2), undefined, options);
		expect((next as PooledCredential).accounts).toBeUndefined();
		expect(next).toMatchObject({ refresh: "refresh-new", expires: 2 });
	});

	test("the matching slot keeps its name, label and place; its stale block fields are dropped", () => {
		const stored: PooledCredential = {
			...login(personA, "old", 1),
			accounts: [
				{
					name: "default",
					displayName: "Work",
					source: "login",
					access: jwt(personA, "old"),
					refresh: "refresh-old",
					expires: 1,
					...{ blockReason: "auth_error", blockedUntil: 99 },
				},
				{ name: "login-2", source: "login", access: jwt(personB, "b"), refresh: "refresh-b", expires: 1 },
			],
		};
		const allocated: string[] = [];
		const next = appendLoginSlot(stored, login(personA, "new", 2), (name) => allocated.push(name), options);
		expect(listSlots(next as PooledCredential)).toEqual([
			{
				name: "default",
				displayName: "Work",
				source: "login",
				access: jwt(personA, "new"),
				refresh: "refresh-new",
				expires: 2,
			},
			stored.accounts?.[1],
		]);
		expect(allocated).toEqual(["default"]);
		expect(next).toMatchObject({ access: jwt(personA, "new"), refresh: "refresh-new", expires: 2 });
	});

	test("older duplicates of the same account collapse into the first, and a pin or order naming one follows it", () => {
		const stored: PooledCredential = {
			...login(personB, "b", 1),
			accounts: [
				{ name: "default", source: "login", access: jwt(personA, "1"), refresh: "refresh-1", expires: 1 },
				{ name: "login-2", source: "login", access: jwt(personB, "b"), refresh: "refresh-b", expires: 1 },
				{ name: "login-3", source: "login", access: jwt(personA, "3"), refresh: "refresh-3", expires: 3 },
			],
			pinned: "login-3",
			order: ["login-3", "login-2", "default"],
		};
		const next = appendLoginSlot(stored, login(personA, "new", 4), undefined, options) as PooledCredential;
		expect(listSlots(next).map((slot) => [slot.name, slot.refresh])).toEqual([
			["default", "refresh-new"],
			["login-2", "refresh-b"],
		]);
		expect(next.pinned).toBe("default");
		expect(next.order).toEqual(["default", "login-2"]);
		expect(next).toMatchObject({ refresh: "refresh-b" });
	});

	test("a different account still appends, and so does a login whose identity is unknown", () => {
		const stored = login(personA, "a", 1);
		const other = appendLoginSlot(stored, login(personB, "b", 1), undefined, options) as PooledCredential;
		expect(listSlots(other).map((slot) => slot.name)).toEqual(["default", "login-2"]);
		const unknown = appendLoginSlot(stored, login({ chatgpt_account_id: "ws-1" }, "x", 1), undefined, options);
		expect(listSlots(unknown as PooledCredential).map((slot) => slot.name)).toEqual(["default", "login-2"]);
	});
});

describe("Models.login stores a ChatGPT re-login over the saved account (omo#9633)", () => {
	test("two logins as the same person leave one account holding the newest tokens", async () => {
		const logins = [login(personA, "old", 1), login(personA, "new", 2)];
		const provider = createProvider({
			id: "chatgpt-relogin",
			name: "ChatGPT re-login",
			baseUrl: "https://chatgpt.example/v1",
			auth: { oauth: { ...shippedOAuth, login: async () => logins.shift() ?? login(personA, "x", 9) } },
			models: [],
			api: "openai-responses" as never,
		});
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(provider);
		const interaction = { signal: AbortSignal.timeout(5_000), prompt: async () => "", notify: () => {} };

		await models.login(provider.id, "oauth", interaction);
		await models.login(provider.id, "oauth", interaction);

		const stored = (await store.read(provider.id)) as PooledCredential | undefined;
		expect(listSlots(stored).map((slot) => [slot.name, slot.refresh])).toEqual([["default", "refresh-new"]]);
	});
});

// #5974 review HIGH: reauthorizing a signed-out account restored nothing and appended a duplicate login-N.
describe("reauthorizing a named saved account restores it in place (#5003)", () => {
	const signedOut = { access: "", refresh: "", expires: 0, signedOut: true as const };

	test("a one-account sign-out is restored, not duplicated, and its sibling is untouched", () => {
		const work = { ...login(personA, "work", 1), name: "work", source: "login" as const, displayName: "Work" };
		const home = { ...login(personB, "home", 1), name: "home", source: "login" as const };
		const stored: PooledCredential = {
			...home,
			accounts: [{ ...work, ...signedOut }, home],
		};
		let allocated: string | undefined;
		const next = appendLoginSlot(
			stored,
			login(personA, "fresh", 9),
			(name) => {
				allocated = name;
			},
			{ accountIdentity: identity, reauthorizeSlot: "work" },
		) as PooledCredential;

		expect(allocated).toBe("work");
		expect(listSlots(next).map((slot) => slot.name)).toEqual(["work", "home"]);
		const restored = listSlots(next).find((slot) => slot.name === "work");
		expect(restored).toMatchObject({ refresh: "refresh-fresh", expires: 9, displayName: "Work", source: "login" });
		expect(restored).not.toHaveProperty("signedOut");
		expect(listSlots(next).find((slot) => slot.name === "home")).toEqual(home);
		expect(next).toMatchObject({ refresh: home.refresh });
	});

	test("a whole signed-out credential takes the restored account as its projection", () => {
		const only = { ...login(personA, "old", 1), name: "default", source: "login" as const };
		const stored: PooledCredential = { ...only, ...signedOut, accounts: [{ ...only, ...signedOut }] };
		const next = appendLoginSlot(stored, login(personA, "fresh", 9), undefined, {
			accountIdentity: identity,
			reauthorizeSlot: "default",
		}) as PooledCredential;

		expect(listSlots(next).map((slot) => slot.name)).toEqual(["default"]);
		expect(next).toMatchObject({ refresh: "refresh-fresh", expires: 9 });
		expect(next).not.toHaveProperty("signedOut");
		expect(listSlots(next)[0]).not.toHaveProperty("signedOut");
	});
});

// #5974 review MEDIUM: a reauthorization must not swap a different ChatGPT account into the chosen slot.
describe("reauthorizing a saved account refuses a different signed-in account (#5003)", () => {
	const options = (slot: string) => ({ accountIdentity: identity, reauthorizeSlot: slot });

	test("legacy route: another person's token is refused and nothing changes", () => {
		const work = { ...login(personA, "work", 1), name: "work", source: "login" as const };
		const stored: PooledCredential = { ...work, accounts: [work] };
		expect(() => appendLoginSlot(stored, login(personB, "other", 9), undefined, options("work"))).toThrow(
			ReauthorizeAccountMismatchError,
		);
	});

	test("legacy route, signed out: a different workspace is refused; the same workspace is restored", () => {
		const cleared = { access: "", refresh: "", expires: 0, signedOut: true as const };
		const work = { ...login(personA, "work", 1), ...cleared, name: "work", source: "login" as const };
		const stored: PooledCredential = { ...work, accounts: [work] };
		const otherWorkspace = { ...login(personA, "x", 9), accountId: "ws-2" };
		expect(() => appendLoginSlot(stored, otherWorkspace, undefined, options("work"))).toThrow(
			ReauthorizeAccountMismatchError,
		);
		const next = appendLoginSlot(stored, login(personA, "fresh", 9), undefined, options("work")) as PooledCredential;
		expect(listSlots(next).map((slot) => slot.name)).toEqual(["work"]);
		expect(next).toMatchObject({ refresh: "refresh-fresh" });
	});

	test("SIWC route: a different subject or a route switch is refused", () => {
		const siwc = {
			route: "siwc" as const,
			issuer: "https://auth.openai.com",
			subject: "sub-a",
			clientId: "client-1",
		};
		const work = { ...login(personA, "work", 1), ...siwc, name: "work", source: "login" as const };
		const stored: PooledCredential = { ...work, accounts: [work] };
		expect(() =>
			appendLoginSlot(stored, { ...login(personA, "x", 9), ...siwc, subject: "sub-b" }, undefined, options("work")),
		).toThrow(ReauthorizeAccountMismatchError);
		expect(() => appendLoginSlot(stored, login(personA, "x", 9), undefined, options("work"))).toThrow(
			ReauthorizeAccountMismatchError,
		);
	});

	test("Models.login surfaces the refusal itself and leaves the stored account untouched", async () => {
		const work = { ...login(personA, "work", 1), name: "work", source: "login" as const };
		const stored: PooledCredential = { ...work, accounts: [work] };
		const provider = createProvider({
			id: "chatgpt-reauth-mismatch",
			name: "ChatGPT reauthorize mismatch",
			baseUrl: "https://chatgpt.example/v1",
			auth: { oauth: { ...shippedOAuth, login: async () => login(personB, "other", 9) } },
			models: [],
			api: "openai-responses" as never,
		});
		const store = new InMemoryCredentialStore();
		await store.modify(provider.id, async () => stored);
		const models = createModels({ credentials: store });
		models.setProvider(provider);
		const interaction = { signal: AbortSignal.timeout(5_000), prompt: async () => "", notify: () => {} };

		await expect(
			models.login(provider.id, "oauth", interaction, { reauthorize: work, reauthorizeSlot: "work" }),
		).rejects.toBeInstanceOf(ReauthorizeAccountMismatchError);
		expect(await store.read(provider.id)).toEqual(stored);
	});
});
