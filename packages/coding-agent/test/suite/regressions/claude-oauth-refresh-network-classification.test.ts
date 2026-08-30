import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	type ClaudeSdkOauthCredential,
	emptyCredential,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/claude-sdk-oauth/failover.ts";

const FUTURE = 4_102_444_800_000;

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

	it("persists only a temporary cooldown before failing over after a transport reset", async () => {
		const accounts = [
			{ name: "primary", access: "access-a", refresh: "refresh-a", expires: FUTURE, source: "login" as const },
			{ name: "backup", access: "access-b", refresh: "refresh-b", expires: FUTURE, source: "login" as const },
		];
		const store = AuthStorage.inMemory({
			"claude-sdk-oauth": { ...emptyCredential(), accounts },
		});
		const attempts: string[] = [];
		const output: string[] = [];
		const stream = runFailover({
			accounts,
			selectFn: (pool) => pool.find((account) => account.blockedUntil === undefined) ?? pool[0]!,
			runAttempt: async function* (account) {
				attempts.push(account.name);
				if (account.name === "primary") throw new Error("connection reset by peer");
				yield "ok";
			},
			classify: classifySdkError,
			store,
			providerId: "claude-sdk-oauth",
			now: () => 1_000,
			baseBlockMs: 500,
		});

		for await (const event of stream) output.push(event);

		expect(attempts).toEqual(["primary", "backup"]);
		expect(output).toEqual(["ok"]);
		const credential = store.get("claude-sdk-oauth");
		expect(credential?.type).toBe("oauth");
		expect(
			(credential as ClaudeSdkOauthCredential).accounts?.find((account) => account.name === "primary"),
		).toMatchObject({
			blockReason: "other",
			blockedUntil: 1_500,
		});
	});
});
