// omo#7084 / omo#8383: the token re-login cases went with the senpi-owned Claude login (senpi#4436); a re-login now
// signs the same account in again through the Claude CLI (4436-login-via-cli, 4436-legacy-sign-out).
import { describe, expect, it } from "vitest";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

const blockedDefault = cliSlot("default", { blockReason: "auth_error", blockedUntil: Date.now() + 60_000 });

describe("AllAccountsBlockedError names the dominant block reason (omo#8383)", () => {
	it("carries auth_error when every slot is auth-blocked", () => {
		let caught: unknown;
		try {
			selectAccount([blockedDefault]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBe("auth_error");
	});

	it("carries no auth reason when another slot only waits on a deadline (senpi#2081)", () => {
		const rateLimited = cliSlot("rl", { blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" });
		let caught: unknown;
		try {
			selectAccount([blockedDefault, rateLimited]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBeUndefined();
	});

	it("carries no auth reason for purely timed blocks", () => {
		const rateLimited = cliSlot("rl", { blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" });
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
