import { describe, expect, it } from "vitest";
import {
	CURSOR_CONTEXT_OVERFLOW_WORDINGS,
	type CursorCliErrorKind,
	classifyCursorCliError,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/errors.ts";

const ALL_ERROR_KINDS = [
	"binary_missing",
	"invalid_api_key",
	"keychain_locked",
	"invalid_model",
	"rate_limit",
	"auth_error",
	"context_overflow",
	"network",
	"malformed_stream",
	"other",
] as const satisfies readonly CursorCliErrorKind[];

describe("classifyCursorCliError", () => {
	it("exposes the complete closed error-kind contract", () => {
		expect(ALL_ERROR_KINDS).toHaveLength(10);
	});

	it("classifies CursorAgentNotInstalledError.kind structurally", () => {
		expect(classifyCursorCliError({ thrown: { kind: "binary_missing", message: "install cursor-agent" } })).toEqual({
			kind: "binary_missing",
			retryable: false,
		});
	});

	it("requires both observed CURSOR_API_KEY lines for invalid_api_key", () => {
		const stderr = [
			"The provided API key is invalid.",
			"The API key was loaded from the CURSOR_API_KEY environment variable.",
		].join("\n");
		expect(classifyCursorCliError({ exitCode: 1, stderr })).toEqual({ kind: "invalid_api_key", retryable: false });
		expect(classifyCursorCliError({ stderr: "The provided API key is invalid." })).toEqual({
			kind: "other",
			retryable: false,
		});
	});

	it("classifies the observed locked-keychain wording", () => {
		expect(
			classifyCursorCliError({
				stderr: "Error: Your macOS login keychain is locked.\nRun security unlock-keychain and try again.",
			}),
		).toEqual({ kind: "keychain_locked", retryable: false });
	});

	it("classifies an invalid-model result event even when the process exits successfully", () => {
		expect(
			classifyCursorCliError({
				exitCode: 0,
				resultEvent: { type: "result", subtype: "error", is_error: true, result: "Invalid model value: bogus" },
			}),
		).toEqual({ kind: "invalid_model", retryable: false });
	});

	it("uses the default rate-limit block and accepts 429 wording", () => {
		expect(classifyCursorCliError({ stderr: "HTTP 429: rate limit exceeded" })).toEqual({
			kind: "rate_limit",
			retryable: true,
			blockMs: 60_000,
		});
	});

	it("uses server rate-limit hints and caps them at 48 hours", () => {
		expect(
			classifyCursorCliError({
				resultEvent: { is_error: true, result: "rate_limit", retryAfterMs: 2_500 },
			}),
		).toEqual({ kind: "rate_limit", retryable: true, blockMs: 2_500 });
		expect(classifyCursorCliError({ stderr: "HTTP 429 retry-after: 200000" })).toEqual({
			kind: "rate_limit",
			retryable: true,
			blockMs: 48 * 60 * 60 * 1_000,
		});
	});

	it("classifies authentication failures without an expiring block", () => {
		expect(
			classifyCursorCliError({ resultEvent: { type: "result", is_error: true, result: "HTTP 401 Unauthorized" } }),
		).toEqual({ kind: "auth_error", retryable: false });
	});

	it("keeps context_overflow defined but unmatched until the probe supplies wording", () => {
		expect(CURSOR_CONTEXT_OVERFLOW_WORDINGS).toEqual([]);
		expect(classifyCursorCliError({ stderr: "context window exceeded for this request" })).toEqual({
			kind: "other",
			retryable: false,
		});
	});

	it("classifies bounded network wording as retryable", () => {
		expect(classifyCursorCliError({ thrown: new Error("read ECONNRESET") })).toEqual({
			kind: "network",
			retryable: true,
		});
	});

	it("classifies parser failures by their typed kind", () => {
		expect(classifyCursorCliError({ thrown: { kind: "malformed_stream", message: "invalid NDJSON" } })).toEqual({
			kind: "malformed_stream",
			retryable: false,
		});
	});

	it("tolerates malformed input and leaves unknown or misleading near-misses non-retryable", () => {
		expect(classifyCursorCliError(undefined)).toEqual({ kind: "other", retryable: false });
		expect(classifyCursorCliError(null)).toEqual({ kind: "other", retryable: false });
		expect(
			classifyCursorCliError({ exitCode: "garbage", stderr: { nested: null }, resultEvent: 42, thrown: false }),
		).toEqual({ kind: "other", retryable: false });
		expect(classifyCursorCliError({ stderr: "The pirate limit was reached after 4290 attempts" })).toEqual({
			kind: "other",
			retryable: false,
		});
		expect(classifyCursorCliError({ stderr: "service overloaded" })).toEqual({ kind: "other", retryable: false });
	});
});
