import { describe, expect, it } from "vitest";
import { classifySdkError } from "../../../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";

describe("Claude OAuth refresh failure classification", () => {
	it.each([
		"fetch failed; cause=Error: getaddrinfo ENOTFOUND platform.claude.com; code=ENOTFOUND",
		"authentication_failed: Anthropic token refresh request failed; cause=getaddrinfo EAI_AGAIN platform.claude.com",
		"TypeError: fetch failed; cause=ConnectTimeoutError; code=UND_ERR_CONNECT_TIMEOUT",
	])("keeps transient network failures retryable without classifying the token as invalid: %s", (message) => {
		expect(classifySdkError(new Error(message))).toEqual({ kind: "other", retryable: true });
	});

	it.each([
		"authentication_failed: invalid_grant: refresh token revoked",
		"OAuth refresh failed with HTTP 401 unauthorized",
	])("continues to classify actual refresh-token rejection as an auth error: %s", (message) => {
		expect(classifySdkError(new Error(message))).toEqual({ kind: "auth_error", retryable: true });
	});
});
