import { describe, expect, it } from "vitest";
import { accountCanServe, type CredentialAccountSummary } from "../../../src/core/credential-accounts.ts";

const NOW = Date.UTC(2026, 10, 9, 2, 0);
const LATER = NOW + 3_600_000;

function account(fields: Partial<CredentialAccountSummary> = {}): CredentialAccountSummary {
	return { name: "org-a", source: "login", blocked: false, pinned: false, ...fields };
}

describe("#5590 follow-up: whether a pooled account can serve the requested model", () => {
	it.each([
		["an unblocked account", account(), "claude-opus-5-5", true],
		["an account with a live block", account({ blocked: true, blockedReason: "rate_limit", blockedUntil: LATER }), "claude-opus-5-5", false],
		["a signed-out account the pool skips", account({ signedOut: true }), "claude-opus-5-5", false],
		["a family block on a model of that family", account({ blockedModels: [{ model: "opus", until: LATER }] }), "claude-opus-5-5", false],
		["a family block on another family", account({ blockedModels: [{ model: "opus", until: LATER }] }), "claude-sonnet-5", true],
		["an exact-id block on that exact model", account({ blockedModels: [{ model: "claude-opus-4-5", until: LATER }] }), "claude-opus-4-5", false],
		["an exact-id block on a longer id that contains it", account({ blockedModels: [{ model: "claude-opus-4-5", until: LATER }] }), "claude-opus-4-5-thinking", true],
		["an exact-id key with regex characters", account({ blockedModels: [{ model: "gpt-5.1(x)", until: LATER }] }), "gpt-5.1-codex", true],
		["an expired model block", account({ blockedModels: [{ model: "opus", until: NOW - 1 }] }), "claude-opus-5-5", true],
	])("%s", (_label, summary, modelId, canServe) => {
		expect(accountCanServe(summary, modelId, NOW)).toBe(canServe);
	});
});
