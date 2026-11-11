import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeCliConnectionTest } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-connection-test.ts";
import { withCheck } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-login-slots.ts";
import { SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { signOutLegacyClaudeLogins } from "../src/core/anthropic-legacy-sign-out.ts";

const { lane } = vi.hoisted(() => ({ lane: vi.fn() }));
vi.mock("../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts", () => ({
	queryWithAuthLane: lane,
}));
vi.mock("../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts", () => ({
	loadClaudeAgentSdk: async () => {},
	getSdkBoundary: () => ({ query: vi.fn() }),
}));

afterEach(() => vi.clearAllMocks());

const input = {
	name: "work",
	model: "claude-opus-5-5",
	executable: "/synthetic/claude",
	cwd: "/synthetic/workspace",
	providerSettings: {},
	now: () => 42,
};
const old = {
	name: "work",
	source: "login" as const,
	store: "claude-cli" as const,
	dirId: "a".repeat(32),
	signedInAt: 1,
};

describe("Claude subscription account checks (desktop#6444)", () => {
	it.each(
		(["thrown", "result"] as const).flatMap((channel) =>
			(
				[
					["API key", `sk-ant-api03-${"x".repeat(64)}`, "", ""],
					["OAuth access", `sk-ant-oat01-${"y".repeat(64)}`, "", ""],
					["OAuth refresh", `sk-ant-ort01-${"z".repeat(64)}`, "", ""],
					["Bearer JWT", `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`, "Authorization: Bearer ", ""],
					["JSON refresh", `synthetic-refresh-${"r".repeat(32)}`, '{"refresh_token":"', '"}'],
				] as const
			).map(([kind, secret, prefix, suffix]) => ({ channel, kind, secret, prefix, suffix })),
		),
	)("redacts $kind in the $channel SDK error before storing it", async ({ channel, kind, secret, prefix, suffix }) => {
		const message = `Synthetic provider rejection (${kind}): ${prefix}${secret}${suffix}`;
		lane.mockReturnValue(
			channel === "thrown"
				? {
						async next() {
							throw Object.assign(new Error(message), { status: 403 });
						},
						[Symbol.asyncIterator]() {
							return this;
						},
					}
				: {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "result",
								subtype: "error_during_execution",
								is_error: true,
								errors: [message],
								api_error_status: 403,
							};
						},
					},
		);

		const check = await runClaudeCliConnectionTest(input);

		expect(check.status).toBe(403);
		expect(check.message?.includes("Synthetic provider rejection")).toBe(true);
		// Boolean assertions prevent a failed redaction test from printing credential material.
		expect(check.message?.includes(secret)).toBe(false);
		expect(check.message?.includes("[REDACTED]")).toBe(true);
	});

	it("keeps the provider status and message while redacting credentials", async () => {
		const token = `sk-ant-oat01-${"x".repeat(80)}`;
		lane.mockReturnValue({
			async next() {
				throw Object.assign(new Error(`Model access denied; Bearer ${token}`), { status: 403 });
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		});

		const check = await runClaudeCliConnectionTest(input);

		expect(check).toMatchObject({
			model: input.model,
			outcome: "failed",
			status: 403,
			message: "Model access denied; Bearer [REDACTED]",
			at: 42,
		});
		expect(JSON.stringify(check)).not.toContain(token);
	});

	it("keeps the provider's result error and HTTP status", async () => {
		lane.mockReturnValue({
			close() {},
			async *[Symbol.asyncIterator]() {
				yield {
					type: "result",
					subtype: "error_during_execution",
					is_error: true,
					errors: ["This account has no credits for the requested model"],
					api_error_status: 402,
				};
			},
		});

		expect(await runClaudeCliConnectionTest(input)).toMatchObject({
			outcome: "failed",
			status: 402,
			message: expect.stringContaining("This account has no credits for the requested model"),
		});
	});

	it("does not stamp an old credential's failed test onto a fresh login", () => {
		const fresh = { ...old, dirId: "b".repeat(32), signedInAt: 2 };
		const credential = { type: "oauth" as const, ...SENTINEL_OAUTH_FIELDS, accounts: [fresh] };

		expect(
			withCheck(
				credential,
				old.name,
				{ model: input.model, outcome: "failed", reason: "authentication", at: 3 },
				old.dirId,
			),
		).toEqual(credential);
	});

	it("stores a completed check when the tested credential still owns the slot", () => {
		const credential = { type: "oauth" as const, ...SENTINEL_OAUTH_FIELDS, accounts: [old] };
		const check = { model: input.model, outcome: "failed" as const, reason: "auth_error", at: 3 };
		expect(withCheck(credential, old.name, check, old.dirId)).toEqual({
			...credential,
			accounts: [{ ...old, check }],
		});
	});
});

describe("legacy default subscription cleanup (desktop#6445)", () => {
	it("does not turn a flat legacy credential into a default account", () => {
		const migrated = signOutLegacyClaudeLogins({
			"anthropic-subscription": { type: "oauth", access: "dummy", refresh: "dummy", expires: 1 },
		});

		expect(migrated.migrated).toBe(true);
		const result = migrated.data["anthropic-subscription"];
		if (result?.type !== "oauth") throw new Error("Expected the migrated subscription credential");
		expect(result.accounts).toEqual([]);
	});

	it("drops an already migrated legacy default and its pin but keeps a real CLI account named default", () => {
		const legacy = { ...old, name: "default", signInRequired: "legacy_sign_in_retired" as const };
		const credential = {
			type: "oauth" as const,
			...SENTINEL_OAUTH_FIELDS,
			pinned: "default",
			accounts: [legacy, { ...old, name: "personal" }],
		};

		const migrated = signOutLegacyClaudeLogins({ "anthropic-subscription": credential });

		const result = migrated.data["anthropic-subscription"];
		if (result?.type !== "oauth") throw new Error("Expected the migrated subscription credential");
		expect(result.accounts).toEqual([credential.accounts[1]]);
		expect(migrated.data["anthropic-subscription"]).not.toHaveProperty("pinned");
		const real = { ...credential, accounts: [{ ...old, name: "default" }] };
		expect(signOutLegacyClaudeLogins({ "anthropic-subscription": real }).data["anthropic-subscription"]).toEqual(
			real,
		);
		expect(signOutLegacyClaudeLogins(migrated.data).migrated).toBe(false);
	});
});
