import { afterEach, describe, expect, it, vi } from "vitest";
import {
	runClaudeCliConnectionTest,
	STORED_CHECK_MESSAGE_MAX_CHARS,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-connection-test.ts";
import { withCheck } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-login-slots.ts";
import { SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";

const { lane } = vi.hoisted(() => ({ lane: vi.fn() }));
vi.mock("../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts", () => ({
	queryWithAuthLane: lane,
}));
vi.mock("../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts", () => ({
	loadClaudeAgentSdk: async () => {},
	getSdkBoundary: () => ({ query: vi.fn() }),
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

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

	it("reports cancelled, not the SDK's late error, when the caller cancelled first", async () => {
		lane.mockReturnValue({
			close() {},
			async *[Symbol.asyncIterator]() {
				yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["stream closed"] };
			},
		});

		expect(await runClaudeCliConnectionTest({ ...input, signal: AbortSignal.abort() })).toMatchObject({
			outcome: "failed",
			reason: "cancelled",
		});
	});

	it.each([
		["a null-prototype object", Object.create(null)],
		["an Error whose message is not a string", Object.assign(new Error(), { message: 7 })],
	])("returns a failed check when the SDK throws %s", async (_label, thrown) => {
		lane.mockReturnValue({
			async next() {
				throw thrown;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		});

		expect(await runClaudeCliConnectionTest(input)).toMatchObject({ outcome: "failed", reason: expect.any(String) });
	});

	it("caps the stored message so a proxy error page cannot bloat auth.json", async () => {
		lane.mockReturnValue({
			async next() {
				throw new Error(`<html>${"x".repeat(STORED_CHECK_MESSAGE_MAX_CHARS * 3)}</html>`);
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		});

		const check = await runClaudeCliConnectionTest(input);

		expect(check.message?.length).toBe(STORED_CHECK_MESSAGE_MAX_CHARS);
		expect(check.message?.startsWith("<html>")).toBe(true);
	});

	it("never ends the capped message on half of a surrogate pair", async () => {
		const text = `${"x".repeat(STORED_CHECK_MESSAGE_MAX_CHARS - 2)}\u{1F600}${"y".repeat(STORED_CHECK_MESSAGE_MAX_CHARS)}`;
		lane.mockReturnValue({
			async next() {
				throw new Error(text);
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		});

		const check = await runClaudeCliConnectionTest(input);

		expect(check.message?.isWellFormed()).toBe(true);
		expect(check.message?.endsWith("x…")).toBe(true);
	});

	it("reports timeout, not the SDK's late error, when the deadline fired first", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("deadline", "TimeoutError")));
		lane.mockReturnValue({
			close() {},
			async *[Symbol.asyncIterator]() {
				yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["stream closed"] };
			},
		});

		expect(await runClaudeCliConnectionTest(input)).toMatchObject({ outcome: "failed", reason: "timeout" });
	});

	it("reports timeout when both the deadline and the caller's cancel fired", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("deadline", "TimeoutError")));
		lane.mockReturnValue({
			close() {},
			async *[Symbol.asyncIterator]() {
				yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["stream closed"] };
			},
		});

		expect(await runClaudeCliConnectionTest({ ...input, signal: AbortSignal.abort() })).toMatchObject({
			outcome: "failed",
			reason: "timeout",
		});
	});

	it("reports cancelled, not no_result, when the stream ends after the caller cancelled", async () => {
		lane.mockReturnValue({
			close() {},
			async *[Symbol.asyncIterator]() {},
		});

		expect(await runClaudeCliConnectionTest({ ...input, signal: AbortSignal.abort() })).toMatchObject({
			outcome: "failed",
			reason: "cancelled",
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
