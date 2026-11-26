/**
 * senpi#3684: which accounts the usage poll speaks for, and how it reads the endpoints. Accounts are named
 * as turns name them. A Claude account polls only with its `CLAUDE_CODE_OAUTH_TOKEN` env token: a claude CLI
 * account's token lives in the CLI's own store, and no stored Claude token is read or renewed (senpi#4436).
 * An expired ChatGPT token is left for a turn to renew. Payload shapes map onto the ids turns report.
 */
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { listPollAccounts } from "../../../src/core/subscription-limits/usage-accounts.ts";
import { claudeWindowsFromUsage, codexUsage } from "../../../src/core/subscription-limits/usage-endpoints.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

const NOW = Date.parse("2026-10-19T04:00:00Z");
const token = (tag: string) => `${tag}-${"t".repeat(48)}`;

function storage() {
	return AuthStorage.inMemory({
		"anthropic-subscription": {
			type: "oauth",
			access: "claude-sdk-oauth-managed",
			refresh: "claude-sdk-oauth-managed",
			expires: 4102444800000,
			accounts: [
				cliSlot("cli"),
				{ name: "retired", access: token("access"), refresh: token("refresh"), expires: NOW - 1, source: "login" },
			],
		},
		"chatgpt-subscription": {
			type: "oauth",
			access: token("codex"),
			refresh: token("codex-refresh"),
			expires: NOW - 1,
		},
	} as never);
}

describe("usage poll accounts and payloads (senpi#3684)", () => {
	it("names accounts as turns do and polls Claude only with an env token", async () => {
		const accounts = await listPollAccounts({
			store: storage(),
			env: (name) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? token("env") : undefined),
			now: () => NOW,
		});
		const signal = new AbortController().signal;
		const resolved = Object.fromEntries(
			await Promise.all(
				accounts.map(async (entry) => [`${entry.provider}/${entry.account}`, await entry.access(signal)]),
			),
		);

		expect(resolved).toEqual({
			"anthropic-subscription/env": { access: token("env") },
			"chatgpt-subscription/default": undefined,
		});
	});

	it("reads Claude's limits[] and legacy shapes, and ChatGPT's windows, onto the turn ids", () => {
		expect(
			claudeWindowsFromUsage({
				limits: [
					{ kind: "weekly_scoped", percent: 30, scope: { model: { display_name: "Opus" } } },
					{ kind: "unknown", percent: 99 },
				],
			}),
		).toEqual([{ id: "claude:7d_opus", label: "7d opus", windowMinutes: 10080, usedPercent: 30 }]);
		expect(
			claudeWindowsFromUsage({
				five_hour: { utilization: 22, resets_at: "2026-10-19T09:00:00+00:00" },
				seven_day_sonnet: { utilization: 4 },
				extra_usage: null,
			}),
		).toEqual([
			{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 22, resetsAt: "2026-10-19T09:00:00.000Z" },
			{ id: "claude:7d_sonnet", label: "7d sonnet", windowMinutes: 10080, usedPercent: 4 },
		]);
		expect(
			codexUsage({
				rate_limit: {
					secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_at: 1_792_400_000 },
				},
			}),
		).toEqual({
			windows: [
				{
					id: "codex:secondary",
					label: "7d",
					windowMinutes: 10080,
					usedPercent: 61,
					resetsAt: new Date(1_792_400_000_000).toISOString(),
				},
			],
		});
	});
});
