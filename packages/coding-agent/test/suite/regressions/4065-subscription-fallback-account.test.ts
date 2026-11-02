import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { _resetLongContextForTesting } from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

const directory = mkdtempSync(join(tmpdir(), "senpi-4065-account-"));
afterEach(() => {
	resetAuthLaneBoundary();
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

// senpi#4065: A's request-local downgrade must not constrain B after account failover.
it("restores 1M when a standard-window retry fails over to a different account", async () => {
	_resetLongContextForTesting(join(directory, "long-context.json"));
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () => {
		let credential = emptyCredential();
		for (const name of ["a", "b"]) {
			credential = addAccount(credential, cliSlot(name));
		}
		return credential;
	});
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => cliLaneEnv(),
		getAgentDir: () => directory,
	});
	const attempts: Options[] = [];
	const query: SdkQuery = ({ options }) => {
		if (!options) throw new Error("Expected SDK options");
		attempts.push(options);
		const attempt = attempts.length;
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield (
					attempt === 1
						? {
								type: "result",
								subtype: "error_during_execution",
								is_error: true,
								errors: ["API Error: 400 You're out of extra usage."],
							}
						: attempt === 2
							? {
									type: "result",
									subtype: "error_during_execution",
									is_error: true,
									errors: ["Rate limit exceeded (rate_limit)"],
								}
							: { type: "result", subtype: "success", result: "ok" }
				) as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
	const messages: SDKMessage[] = [];
	for await (const message of queryWithAuthLane({
		prompt: "hi",
		query,
		providerSettings: { tokenInjection: "oauth-slots", pinnedAccount: "a" },
		buildOptions: () => ({
			model: "claude-opus-4-6[1m]",
			env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" },
		}),
	})) {
		messages.push(message);
	}
	expect(attempts.map((options) => cliAccountOf(options.env))).toEqual(["a", "a", "b"]);
	expect(attempts.map((options) => options.model)).toEqual([
		"claude-opus-4-6[1m]",
		"claude-opus-4-6",
		"claude-opus-4-6[1m]",
	]);
	expect(attempts.map((options) => options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS)).toEqual([
		"1000000",
		"200000",
		"1000000",
	]);
	expect(attempts.map((options) => options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS)).toEqual([
		undefined,
		"32000",
		undefined,
	]);
	expect(messages).toEqual([{ type: "result", subtype: "success", result: "ok" }]);
});
