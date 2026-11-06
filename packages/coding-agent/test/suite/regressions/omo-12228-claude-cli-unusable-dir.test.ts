import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Context, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnthropicSubscriptionCredential,
	addAccount,
	type AccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

/**
 * oh-my-openagent#12228: before this guard the lane selected an account whose dir id resolves to no directory and failed
 * with the internal `Invalid Claude account dir id` before any model call, then repeated that on the fallback model.
 */
const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const providerId = "anthropic-subscription";
const context: Context = { messages: [] };
const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-omo-12228-"));
	temporaryDirectories.push(directory);
	return directory;
}

function queryYieldingMessages(seen: Options[]): never {
	return ((input: { options?: Options }) => {
		if (input.options !== undefined) seen.push(input.options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	}) as never;
}

async function storeWith(slots: readonly AccountSlot[]): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () =>
		slots.reduce<AnthropicSubscriptionCredential>(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential(),
		),
	);
	return store;
}

function configure(store: InMemoryCredentialStore, seen: Options[]): void {
	const agentDir = temporaryDirectory();
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin", ...cliLaneEnv() }),
		getAgentDir: () => agentDir,
	});
	overrideSdkBoundary({ query: queryYieldingMessages(seen) });
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("oh-my-openagent#12228 a Claude CLI account with an unusable account dir id", () => {
	it("fails as a sign-in prompt and runs no query instead of the internal dir-id error", async () => {
		const seen: Options[] = [];
		configure(await storeWith([cliSlot("broken", { dirId: "" })]), seen);

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(0);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain("Sign in again with Claude to keep using: broken");
		expect(final.errorMessage).not.toContain("Invalid Claude account dir id");
	});

	it("serves the turn on a readable account and never prepares the unusable one", async () => {
		const seen: Options[] = [];
		configure(await storeWith([cliSlot("broken", { dirId: "not-a-dir-id" }), cliSlot("work")]), seen);

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(1);
		expect(cliAccountOf(seen[0]?.env)).toBe("work");
		expect(final.stopReason).not.toBe("error");
	});

	it("still refuses to name a directory for an id the store cannot use", () => {
		expect(() => accountDirFor(temporaryDirectory(), "")).toThrow("Invalid Claude account dir id");
	});
});
