import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	AllCursorAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/cursor-cli-oauth/affinity.ts";
import { cursorCliDiagnostic } from "../../../src/core/extensions/builtin/cursor-cli-oauth/provider-diagnostic.ts";
import { providerRetryAt } from "../../../src/core/extensions/builtin/goal/provider-retry.ts";

const NOW = Date.parse("2026-11-05T05:00:00.000Z");

function refusal(accounts: { name: string; blockedUntil?: number; blockReason?: "rate_limit" | "auth_error" }[]) {
	try {
		selectAccount(accounts, { now: NOW });
	} catch (error) {
		return error;
	}
	throw new Error("expected every account to be blocked");
}

function failedTurn(diagnostic: AssistantMessage["providerDiagnostic"]): AgentMessage[] {
	const message = {
		role: "assistant",
		content: [],
		api: "cursor-cli",
		provider: "cursor-cli-oauth",
		model: "auto",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "All Cursor CLI OAuth accounts are blocked.",
		timestamp: NOW,
		...(diagnostic === undefined ? {} : { providerDiagnostic: diagnostic }),
	} satisfies AssistantMessage;
	return [message];
}

describe("senpi#4092 Cursor CLI OAuth pool refusal carries a typed diagnostic", () => {
	it("names a rate limit and the soonest reset when an account comes back on its own", () => {
		const soon = NOW + 10 * 60_000;
		const error = refusal([
			{ name: "a", blockedUntil: soon, blockReason: "rate_limit" },
			{ name: "b", blockedUntil: NOW + 60 * 60_000, blockReason: "rate_limit" },
			{ name: "c", blockReason: "auth_error" },
		]);
		expect(error).toBeInstanceOf(AllCursorAccountsBlockedError);
		const diagnostic = cursorCliDiagnostic(error);
		expect(diagnostic).toEqual({
			category: "rate_limit",
			code: "account_pool_blocked",
			evidence: "structured_code",
			resetsAt: soon,
		});
		expect(providerRetryAt(failedTurn(diagnostic), NOW)).toBe(soon);
	});

	it("names a sign-in block when every account waits on a new login", () => {
		const error = refusal([
			{ name: "a", blockReason: "auth_error" },
			{ name: "b", blockReason: "auth_error" },
		]);
		expect(cursorCliDiagnostic(error)).toEqual({
			category: "auth",
			code: "account_pool_auth_blocked",
			evidence: "structured_code",
		});
	});

	it("finds the refusal behind a wrapping error and ignores unrelated failures", () => {
		const error = refusal([{ name: "a", blockedUntil: NOW + 5_000, blockReason: "rate_limit" }]);
		expect(cursorCliDiagnostic(new Error("turn failed", { cause: error }))?.code).toBe("account_pool_blocked");
		expect(cursorCliDiagnostic(new Error("socket hang up"))).toBeUndefined();
	});
});
