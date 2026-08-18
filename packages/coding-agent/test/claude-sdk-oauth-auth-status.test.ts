import type { AuthCheck, AuthContext, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { emptyCredential } from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";

type OAuthAvailabilityCheck = (input: {
	ctx: AuthContext;
	credential?: OAuthCredential;
}) => Promise<AuthCheck | undefined>;

function authContext(environment: Record<string, string> = {}): AuthContext {
	return {
		env: async (name) => environment[name],
		fileExists: async () => false,
	};
}

type TokenInjectionLane = "oauth-slots" | "config-dir" | "ambient";

function availabilityCheck(
	readAmbientAuthStatus: () => Promise<boolean>,
	readSettings?: () => { tokenInjection?: TokenInjectionLane } | undefined,
): OAuthAvailabilityCheck {
	const config = createOAuthConfig({
		readCurrent: async () => undefined,
		readAmbientAuthStatus,
		readSettings,
	} as Parameters<typeof createOAuthConfig>[0] & {
		readAmbientAuthStatus: () => Promise<boolean>;
		readSettings?: () => { tokenInjection?: TokenInjectionLane } | undefined;
	}) as ReturnType<typeof createOAuthConfig> & { check?: OAuthAvailabilityCheck };
	expect(config.check).toBeTypeOf("function");
	return config.check as OAuthAvailabilityCheck;
}

function account(name = "managed", access = "access") {
	return { name, refresh: "refresh", access, expires: Date.now() + 60_000, source: "login" as const };
}

describe("claude-sdk-oauth availability", () => {
	it("accepts a stored managed account without probing ambient auth", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const check = availabilityCheck(readAmbientAuthStatus);
		const credential = {
			...emptyCredential(),
			accounts: [
				{
					name: "managed",
					refresh: "refresh",
					access: "access",
					expires: Date.now() + 60_000,
					source: "login" as const,
				},
			],
		};

		expect(await check({ ctx: authContext(), credential })).toEqual({
			type: "oauth",
			source: "Claude SDK OAuth",
		});
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});

	it("rejects a persisted empty managed credential when ambient auth is logged out", async () => {
		const check = availabilityCheck(async () => false);
		expect(await check({ ctx: authContext(), credential: emptyCredential() })).toBeUndefined();
	});

	it("accepts an environment OAuth token without probing ambient auth", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const check = availabilityCheck(readAmbientAuthStatus);
		expect(await check({ ctx: authContext({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" }) })).toEqual({
			type: "oauth",
			source: "Claude SDK OAuth",
		});
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});

	it("accepts an authenticated ambient Claude CLI", async () => {
		const check = availabilityCheck(async () => true);
		expect(await check({ ctx: authContext() })).toEqual({
			type: "oauth",
			source: "Claude SDK OAuth",
		});
	});

	it("rejects a logged-out ambient Claude CLI", async () => {
		const check = availabilityCheck(async () => false);
		expect(await check({ ctx: authContext() })).toBeUndefined();
	});

	it("reports unconfigured when explicit ambient setting, stored accounts, and ambient CLI logged out", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const check = availabilityCheck(readAmbientAuthStatus, () => ({ tokenInjection: "ambient" }));
		const credential = { ...emptyCredential(), accounts: [account()] };

		expect(await check({ ctx: authContext(), credential })).toBeUndefined();
		expect(readAmbientAuthStatus).toHaveBeenCalled();
	});

	it("reports configured when explicit ambient setting, stored accounts, and ambient CLI logged in", async () => {
		const check = availabilityCheck(
			async () => true,
			() => ({ tokenInjection: "ambient" }),
		);
		const credential = { ...emptyCredential(), accounts: [account()] };

		expect(await check({ ctx: authContext(), credential })).toEqual({
			type: "oauth",
			source: "Claude SDK OAuth",
		});
	});

	it("reports configured without ambient probe when accounts exist and no explicit setting", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const check = availabilityCheck(readAmbientAuthStatus);
		const credential = { ...emptyCredential(), accounts: [account()] };

		expect(await check({ ctx: authContext(), credential })).toEqual({
			type: "oauth",
			source: "Claude SDK OAuth",
		});
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});
});
