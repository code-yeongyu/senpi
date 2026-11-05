import { projectSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it } from "vitest";
import { listAccounts, SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { authContext } from "./support/anthropic-subscription-provider.ts";
import { cliSlot } from "./support/claude-cli-test-slots.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "./support/fake-claude-cli-login.ts";

afterEach(() => cleanupFakeClaudeCliLogins());

describe("claude-sdk-oauth oauth login config", () => {
	it.each([
		["with a prompt answered blank", async () => ""],
		["headless", undefined],
	] as const)("the default name never collides with an existing account (%s)", async (_case, onPrompt) => {
		const cli = fakeClaudeCliLogin();
		const current = {
			type: "oauth" as const,
			...SENTINEL_OAUTH_FIELDS,
			accounts: [
				{ name: "a", source: "login" as const, store: "claude-cli" as const, dirId: "a".repeat(32) },
				{ name: "account-3", source: "login" as const, store: "claude-cli" as const, dirId: "b".repeat(32) },
			],
		};
		const config = createOAuthConfig({ readCurrent: async () => current, claudeCli: cli });
		const credential = await config.login(onPrompt === undefined ? {} : { onPrompt });
		const slots = listAccounts(credential as never);
		expect(
			slots.map((slot) => [slot.name, slot.store, slot.store === "claude-cli" ? slot.dirId : undefined]),
		).toEqual([
			["a", "claude-cli", "a".repeat(32)],
			["account-3", "claude-cli", "b".repeat(32)],
			["account-4", "claude-cli", expect.stringMatching(/^[0-9a-f]{32}$/)],
		]);
	});

	it("second login adds a prompted account name without dropping slots", async () => {
		const existing = await createOAuthConfig({
			readCurrent: async () => undefined,
			claudeCli: fakeClaudeCliLogin(),
		}).login({});
		const config = createOAuthConfig({
			readCurrent: async () => existing as never,
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]?.store).toBe("claude-cli");
	});

	it("keeps sentinel top-level fields and sentinel getApiKey", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const credential = await config.login({});
		expect((credential as { access: string }).access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(config.getApiKey(credential)).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("an aborted login signal cancels the Claude CLI sign-in", async () => {
		const controller = new AbortController();
		controller.abort();
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });

		await expect(config.login({ signal: controller.signal })).rejects.toThrow("Login cancelled");
	});

	it("refreshToken is a preserving no-op", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const credential = await config.login({});
		expect(await config.refreshToken(credential)).toBe(credential);
	});

	it("check does not count a lone legacy flat token credential, which the lane never lists (senpi#4436)", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const legacy = { type: "oauth" as const, access: "fake-a", refresh: "fake-r", expires: 4_102_444_800_000 };
		expect(listAccounts(legacy)).toEqual([]);

		const check = await config.check({ ctx: authContext(), credential: legacy });

		expect(check).toBeUndefined();
	});

	it("slot-scoped resolution projects no credential for a Claude CLI account, so check never counts a projection", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const pool = { type: "oauth" as const, ...SENTINEL_OAUTH_FIELDS, accounts: [cliSlot("work")] };
		const projected = projectSlot(pool, "work");
		expect(projected).toBeUndefined();

		const check = await config.check({
			ctx: authContext(),
			credential: projected?.type === "oauth" ? projected : undefined,
		});

		expect(check).toBeUndefined();
	});

	it("check does not count a stored account that still holds tokens, which the lane never lists (senpi#4436)", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const legacy = { name: "legacy", source: "login" as const, access: "fake-a", refresh: "fake-r", expires: 1 };

		const check = await config.check({
			ctx: authContext(),
			credential: { type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [legacy] } as never,
		});

		expect(check).toBeUndefined();
	});

	it("check still rejects a projected sentinel that names no account", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });

		const check = await config.check({ ctx: authContext(), credential: { type: "oauth", ...SENTINEL_OAUTH_FIELDS } });

		expect(check).toBeUndefined();
	});
});
