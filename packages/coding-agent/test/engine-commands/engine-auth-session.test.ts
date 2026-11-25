import { describe, expect, expectTypeOf, it } from "vitest";
import { splitAccount } from "../../src/cli/auth-account-check.ts";
import type { CredentialAccountSummary } from "../../src/core/credential-accounts.ts";
import { type SessionAuthStatus, toSessionAuthStatus } from "../../src/engine/index.ts";
import type { FieldPaths } from "../../src/engine/result-fields.ts";

const CANARY = "sk-canary-session-7451";
const CHECK = {
	model: "claude-model",
	outcome: "failed",
	reason: "rate_limit",
	message: "limit",
	status: 429,
	at: 1,
} as const;
const BASE: CredentialAccountSummary = {
	name: "work",
	displayName: "Work",
	source: "login",
	blocked: false,
	pinned: false,
	blockedModels: [{ model: "claude-model", until: 2 }],
	email: "person@example.test",
	orgName: "Example Org",
	subscriptionType: "max",
	usageUrl: "https://example.test/usage",
	signIn: "signed_in",
	check: CHECK,
};

function sessionAnswer(account: CredentialAccountSummary): SessionAuthStatus {
	return toSessionAuthStatus({
		status: "ready",
		provider: "anthropic-subscription",
		authType: "oauth",
		accounts: [splitAccount(account)],
	});
}

/** Every field of the provider's response the engine reads for an account, each planted with the canary in turn. */
const PLANTED: ReadonlyArray<readonly [string, CredentialAccountSummary]> = [
	["check.reason", { ...BASE, check: { ...CHECK, reason: CANARY } }],
	["check.message", { ...BASE, check: { ...CHECK, message: CANARY } }],
	["check.model", { ...BASE, check: { ...CHECK, model: CANARY } }],
	["email, as a key-shaped address", { ...BASE, email: `${CANARY}@example.test` }],
	["orgName", { ...BASE, orgName: CANARY }],
	["subscriptionType", { ...BASE, subscriptionType: CANARY }],
	["displayName", { ...BASE, displayName: CANARY }],
	["name", { ...BASE, name: CANARY }],
	["usageUrl", { ...BASE, usageUrl: `https://example.test/${CANARY}` }],
	["blockedModels.model", { ...BASE, blockedModels: [{ model: CANARY, until: 2 }] }],
];

describe("a session's engine.auth.check answer (security design 137d6b9879, owner's option (c))", () => {
	it.each(PLANTED)("never carries a canary planted in %s", (_field, account) => {
		expect(JSON.stringify(splitAccount(account))).toContain(CANARY);
		expect(JSON.stringify(sessionAnswer(account))).not.toContain(CANARY);
	});

	it("answers whether each account is signed in, its provider, and closed codes only", () => {
		expect(sessionAnswer(BASE)).toEqual({
			provider: "anthropic-subscription",
			status: "ready",
			auth_type: "oauth",
			accounts: [{ signed_in: true, check: "rate_limit" }],
		});
		expect(sessionAnswer({ ...BASE, signIn: "needs_sign_in", check: { ...CHECK, reason: CANARY } }).accounts).toEqual(
			[{ signed_in: false, check: "unrecognized" }],
		);
	});

	it("has no email, organisation name or other provider text field in its type", () => {
		expectTypeOf<
			Extract<
				FieldPaths<SessionAuthStatus>,
				`${string}email` | `${string}orgName` | `${string}provider_text${string}`
			>
		>().toEqualTypeOf<never>();
	});
});
