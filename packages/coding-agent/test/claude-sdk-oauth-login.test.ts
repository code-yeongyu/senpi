import type { OAuthAuth } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	addAccount,
	emptyCredential,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";

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

const fresh = { access: "a1", refresh: "r1", expires: Date.now() + 60_000 };

describe("claude-sdk-oauth oauth login config", () => {
	it("offers the existing anthropic credential as an import before a fresh login", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "y" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["imported-anthropic"]);
		expect(slots[0]?.source).toBe("import");
	});

	it("declining the import falls through to a fresh login without the import slot", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			loginFlow: fakeFlow(fresh),
		});
		const prompts: string[] = [];
		const credential = await config.login({
			onPrompt: async (prompt) => {
				prompts.push(prompt.message);
				return prompts.length === 1 ? "n" : "work";
			},
		});
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots.every((slot) => slot.source !== "import")).toBe(true);
	});

	it("second login adds a prompted account name without dropping slots", async () => {
		const existing = await createOAuthConfig({
			readCurrent: async () => undefined,
			loginFlow: fakeFlow(fresh),
		}).login({});
		const config = createOAuthConfig({
			readCurrent: async () => existing as never,
			loginFlow: fakeFlow({ access: "a2", refresh: "r2", expires: Date.now() + 60_000 }),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]?.access).toBe("a2");
	});

	it("keeps sentinel top-level fields and sentinel getApiKey", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow: fakeFlow(fresh) });
		const credential = await config.login({});
		expect((credential as { access: string }).access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(config.getApiKey(credential)).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("refreshToken is a preserving no-op", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow: fakeFlow(fresh) });
		const credential = await config.login({});
		expect(await config.refreshToken(credential)).toBe(credential);
	});

	it("opens account management instead of starting OAuth when accounts already exist", async () => {
		const current = addAccount(addAccount(emptyCredential(), { name: "default", ...fresh, source: "login" }), {
			name: "work",
			access: "a2",
			refresh: "r2",
			expires: Date.now() + 60_000,
			source: "login",
		});
		const login = vi.fn(async () => ({ type: "oauth" as const, ...fresh }));
		const selections = ["pin", "work"];
		const config = createOAuthConfig({
			readCurrent: async () => current,
			loginFlow: { ...fakeFlow(fresh), login },
		});

		const credential = await config.login({
			onSelect: async ({ options }) => {
				expect(options.length).toBeGreaterThan(0);
				return selections.shift();
			},
		});

		expect(credential).toMatchObject({ pinned: "work" });
		expect(login).not.toHaveBeenCalled();
	});

	it("logout-all clears accounts, pins, and stale slot state", async () => {
		const current = {
			...addAccount(emptyCredential(), { name: "default", ...fresh, source: "login" as const }),
			pinned: "default",
			slotState: { default: { blockedUntil: 123, blockReason: "quota" } },
		};
		const selections = ["logout-all", "yes"];
		const config = createOAuthConfig({ readCurrent: async () => current, loginFlow: fakeFlow(fresh) });

		const credential = await config.login({
			onSelect: async () => selections.shift(),
		});

		expect(listAccounts(credential as never)).toEqual([]);
		expect(credential).not.toHaveProperty("pinned");
		expect(credential).not.toHaveProperty("slotState");
	});

	it("unblock clears only the selected account block", async () => {
		const current = addAccount(emptyCredential(), {
			name: "default",
			...fresh,
			source: "login",
			blockedUntil: 123,
			blockReason: "quota",
		});
		const selections = ["unblock", "default"];
		const config = createOAuthConfig({ readCurrent: async () => current, loginFlow: fakeFlow(fresh) });

		const credential = await config.login({ onSelect: async () => selections.shift() });
		expect(listAccounts(credential as never)[0]).not.toHaveProperty("blockReason");
		expect(listAccounts(credential as never)[0]).not.toHaveProperty("blockedUntil");
	});

	it("includes environment accounts in pin and unblock controls", async () => {
		const current = {
			...emptyCredential(),
			slotState: { env: { blockedUntil: 123, blockReason: "quota" } },
		};
		const selections = ["pin", "env"];
		const config = createOAuthConfig({
			readCurrent: async () => current,
			readEnv: (name) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? "environment-token" : undefined),
			loginFlow: fakeFlow(fresh),
		});

		const credential = await config.login({ onSelect: async () => selections.shift() });
		expect(credential).toMatchObject({ pinned: "env" });

		const unblockSelections = ["unblock", "env"];
		const unblocked = await createOAuthConfig({
			readCurrent: async () => current,
			readEnv: (name) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? "environment-token" : undefined),
			loginFlow: fakeFlow(fresh),
		}).login({ onSelect: async () => unblockSelections.shift() });
		expect(unblocked).not.toHaveProperty("slotState");
	});

	it("removes one stored account and its stale state", async () => {
		const current = {
			...addAccount(addAccount(emptyCredential(), { name: "default", ...fresh, source: "login" as const }), {
				name: "work",
				access: "a2",
				refresh: "r2",
				expires: fresh.expires,
				source: "login" as const,
			}),
			slotState: { default: { blockedUntil: 123, blockReason: "quota" } },
		};
		const selections = ["remove", "default"];
		const config = createOAuthConfig({ readCurrent: async () => current, loginFlow: fakeFlow(fresh) });

		const credential = await config.login({ onSelect: async () => selections.shift() });
		expect(listAccounts(credential as never).map((slot) => slot.name)).toEqual(["work"]);
		expect(credential).not.toHaveProperty("slotState");
	});

	it("can clear a stored pin without starting OAuth", async () => {
		const current = {
			...addAccount(emptyCredential(), { name: "default", ...fresh, source: "login" as const }),
			pinned: "default",
		};
		const login = vi.fn(async () => ({ type: "oauth" as const, ...fresh }));
		const config = createOAuthConfig({
			readCurrent: async () => current,
			loginFlow: { ...fakeFlow(fresh), login },
		});

		const credential = await config.login({ onSelect: async () => "unpin" });
		expect(credential).not.toHaveProperty("pinned");
		expect(login).not.toHaveBeenCalled();
	});

	it("can choose add from management and complete a new OAuth login", async () => {
		const current = addAccount(emptyCredential(), { name: "default", ...fresh, source: "login" });
		const login = vi.fn(async () => ({
			type: "oauth" as const,
			access: "a2",
			refresh: "r2",
			expires: fresh.expires,
		}));
		const config = createOAuthConfig({
			readCurrent: async () => current,
			loginFlow: { ...fakeFlow(fresh), login },
		});

		const credential = await config.login({
			onSelect: async () => "add",
			onPrompt: async () => "work",
		});

		expect(listAccounts(credential as never).map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(login).toHaveBeenCalledOnce();
	});
});
