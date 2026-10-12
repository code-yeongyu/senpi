import { describe, expect, test } from "vitest";
import { formatCredentialBlockLog } from "../../../src/core/credential-pool/block-log.ts";

// senpi#3216: when the pool blocks an account, the debug log records why, until when, where the
// cooldown came from and what the provider said, without naming the account or leaking a token.

const NOW = Date.parse("2026-10-12T13:11:00.000Z");

describe("senpi#3216 credential block log line", () => {
	test("a hinted usage limit records its source, the reset and the redacted provider text", () => {
		// given
		const line = formatCredentialBlockLog({
			providerId: "chatgpt-subscription",
			slot: { name: "work-account", lane: "stored" },
			block: {
				reason: "rate_limit",
				cooldownMs: 30 * 3_600_000,
				retryAfterWasCapped: false,
				cooldownSource: "hint",
			},
			modelId: "gpt-6.1-sol",
			failureCount: 1,
			blockedUntil: NOW + 30 * 3_600_000,
			nowMs: NOW,
			providerText:
				"You've hit your weekly usage limit · resets in 30 hours (Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwx)",
		});

		// then
		expect(line).toContain("reason=rate_limit");
		expect(line).toContain("cooldown=hint");
		expect(line).toContain("until=2026-10-13T19:11:00.000Z");
		expect(line).toContain("for=30.0h");
		expect(line).toContain("weekly usage limit");
		expect(line).not.toContain("work-account");
		expect(line).not.toContain("sk-live-abcdefghijklmnopqrstuvwx");
		expect(line).toMatch(/account=stored:[0-9a-f]{8}\b/);
	});

	test("a backoff-only cooldown says so, and an auth block carries no until-time", () => {
		// given / when
		const backoff = formatCredentialBlockLog({
			providerId: "chatgpt-subscription",
			slot: { name: "a", lane: "stored" },
			block: { reason: "rate_limit", cooldownMs: 120_000, retryAfterWasCapped: false, cooldownSource: "backoff" },
			failureCount: 2,
			blockedUntil: NOW + 120_000,
			nowMs: NOW,
		});
		const auth = formatCredentialBlockLog({
			providerId: "chatgpt-subscription",
			slot: { name: "a", lane: "stored" },
			block: { reason: "auth_error" },
			nowMs: NOW,
			providerText: "401 invalid token",
		});

		// then
		expect(backoff).toContain("cooldown=backoff");
		expect(backoff).toContain("for=2m");
		expect(auth).toContain("reason=auth_error");
		expect(auth).not.toContain("until=");
		expect(auth).not.toContain("cooldown=");
	});

	test("token shapes a provider body can echo are redacted: bare JWT bearer, JSON tokens, cookies", () => {
		// given
		const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVl";
		const line = formatCredentialBlockLog({
			providerId: "chatgpt-subscription",
			slot: { name: "a", lane: "stored" },
			block: { reason: "auth_error" },
			nowMs: NOW,
			providerText: `401 {"error":"bad","access_token":"at-secret-value-1234","refresh_token":"rt-secret-value-5678"} Bearer ${jwt} Cookie: session=cookie-secret-abc; other=1`,
		});

		// then
		for (const secret of [jwt, "at-secret-value-1234", "rt-secret-value-5678", "cookie-secret-abc"]) {
			expect(line).not.toContain(secret);
		}
		expect(line).toContain("401");
	});
});
