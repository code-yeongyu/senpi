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
	it("keeps the provider status and message while redacting credentials", async () => {
		const token = `sk-ant-oat01-${"x".repeat(80)}`;
		lane.mockImplementation(async function* () {
			throw Object.assign(new Error(`Model access denied; Bearer ${token}`), { status: 403 });
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
				{ model: input.model, outcome: "failed", reason: "authentication", at: 1 },
				old.dirId,
			),
		).toEqual(credential);
	});
});

describe("legacy default subscription cleanup (desktop#6445)", () => {
	it("does not turn a flat legacy credential into a default account", () => {
		const migrated = signOutLegacyClaudeLogins({
			"anthropic-subscription": { type: "oauth", access: "dummy", refresh: "dummy", expires: 1 },
		});

		expect(migrated.migrated).toBe(true);
		expect(migrated.data["anthropic-subscription"]?.accounts).toEqual([]);
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

		expect(migrated.data["anthropic-subscription"]?.accounts).toEqual([credential.accounts[1]]);
		expect(migrated.data["anthropic-subscription"]).not.toHaveProperty("pinned");
		const real = { ...credential, accounts: [{ ...old, name: "default" }] };
		expect(signOutLegacyClaudeLogins({ "anthropic-subscription": real }).data["anthropic-subscription"]).toEqual(
			real,
		);
		expect(signOutLegacyClaudeLogins(migrated.data).migrated).toBe(false);
	});
});
