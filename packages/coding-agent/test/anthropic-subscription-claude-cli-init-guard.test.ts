import { describe, expect, it } from "vitest";
import { initializationOrAbort } from "../src/core/extensions/builtin/anthropic-subscription/auth-attempt.ts";
import {
	ClaudeCliTokenSourceLeak,
	verifyClaudeCliInitialization,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-token-source.ts";

describe("claude-cli init guard (senpi#4436)", () => {
	it.each([
		["no initialization result", undefined, "account"],
		["no account", { account: undefined }, "account"],
		["no apiProvider", { account: { tokenSource: "none", apiKeySource: "none" } }, "apiProvider"],
		["a bedrock apiProvider", { account: { apiProvider: "bedrock", tokenSource: "none" } }, "apiProvider"],
		["a gateway apiProvider", { account: { apiProvider: "gateway" } }, "apiProvider"],
		[
			"an env tokenSource",
			{ account: { apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" } },
			"tokenSource",
		],
		[
			"an apiKeySource",
			{ account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } },
			"apiKeySource",
		],
	])("refuses %s", (_label, initialization, field) => {
		let thrown: unknown;
		try {
			verifyClaudeCliInitialization(initialization);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ClaudeCliTokenSourceLeak);
		expect((thrown as ClaudeCliTokenSourceLeak).field).toBe(field);
	});

	it("passes a first-party account and returns its profile", () => {
		expect(
			verifyClaudeCliInitialization({
				account: {
					apiProvider: "firstParty",
					tokenSource: "none",
					email: "a@example.com",
					subscriptionType: "max",
				},
			}),
		).toEqual({ email: "a@example.com", subscriptionType: "max" });
	});
});

describe("initializationOrAbort", () => {
	it("rejects when the signal aborts while the initialization hangs", async () => {
		const controller = new AbortController();
		const waiting = initializationOrAbort(new Promise<never>(() => {}), controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow(/initialization aborted/);
	});

	it("rejects at once on an already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(initializationOrAbort(new Promise<never>(() => {}), controller.signal)).rejects.toThrow(
			/initialization aborted/,
		);
	});

	it("resolves with the initialization when it settles first", async () => {
		await expect(initializationOrAbort(Promise.resolve({ ok: 1 }), new AbortController().signal)).resolves.toEqual({
			ok: 1,
		});
	});
});
