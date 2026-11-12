import { describe, expect, it } from "vitest";
import { accountsNeedingUser, type CredentialAccountSummary } from "../../../src/core/credential-accounts.ts";

// senpi#6540 reviews (LOWs): the provider's hold was released when ANY account reported capacity, including an
// account the pool would still skip. Only a usage limit is lifted by usage, so every other block needs the user.
function summary(name: string, extra: Partial<CredentialAccountSummary> = {}): CredentialAccountSummary {
	return { name, source: "login", blocked: false, pinned: false, ...extra };
}

describe("usage from an account the pool cannot select never releases the hold (senpi#6536)", () => {
	it("names every account only the user can bring back", () => {
		const summaries = [
			summary("serves"),
			summary("waiting-on-its-limit", { blocked: true, blockedReason: "rate_limit", blockedUntil: 1 }),
			summary("needs-login", { blocked: true, blockedReason: "auth_error" }),
			summary("disabled", { blocked: true, blockedReason: "disabled" }),
			summary("billing-or-organization", { blocked: true, blockedUntil: 1 }),
			summary("signed-out", { signedOut: true }),
			summary("other-credential-kind", { unused: true }),
		];

		expect(accountsNeedingUser(summaries).sort()).toEqual([
			"billing-or-organization",
			"disabled",
			"needs-login",
			"other-credential-kind",
			"signed-out",
		]);
	});

	it("keeps an account whose only block is the usage limit this fix lifts", () => {
		const limited = summary("limited", { blocked: true, blockedReason: "rate_limit", blockedUntil: 2 });

		expect(accountsNeedingUser([limited])).toEqual([]);
	});

	it("names nothing when every account can serve", () => {
		expect(accountsNeedingUser([summary("a"), summary("b")])).toEqual([]);
	});
});
