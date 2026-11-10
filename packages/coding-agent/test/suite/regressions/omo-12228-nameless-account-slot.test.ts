import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Context, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnthropicSubscriptionCredential,
	type AccountSlot,
	emptyCredential,
	listAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { seatDigest } from "../../../src/core/extensions/builtin/anthropic-subscription/seat-digest.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

/**
 * oh-my-openagent#12228, second call site: a stored Claude CLI account whose `name` never made it into the credential
 * file (the store is read as JSON and cast, so nothing validates the field) reached the lane as `slot.name === undefined`.
 * The seat digest is computed for every resident attempt, so `createHmac(...).update(undefined)` threw the raw crypto
 * TypeError `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received
 * undefined` on the main turn and on every auxiliary call (session-title generation), and signing in again did not clear
 * it because the nameless entry stayed in the file. The user-facing symptom is a turn that dies with that TypeError
 * after the fallback chain walks the models.
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

/** The raw shape a credential file holds when the name field is missing; the store type is applied, not validated. */
const namelessStoredSlot = {
	source: "login",
	store: "claude-cli",
	dirId: "0123456789abcdef0123456789abcdef",
	signedInAt: 1,
} as unknown as AccountSlot;

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-omo-12228-seat-"));
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

async function storeWithRawSlots(slots: readonly unknown[]): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(
		providerId,
		async () => ({ ...emptyCredential(), accounts: slots as AccountSlot[] }) as AnthropicSubscriptionCredential,
	);
	return store;
}

function configure(store: InMemoryCredentialStore, seen: Options[], settings?: unknown): void {
	const agentDir = temporaryDirectory();
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	if (settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
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

describe("oh-my-openagent#12228 a stored Claude account with no name", () => {
	it("is not listed, so no turn can hash an undefined seat", () => {
		const credential = { ...emptyCredential(), accounts: [namelessStoredSlot as AccountSlot] };

		expect(listAccounts(credential, () => undefined)).toHaveLength(0);
	});

	it("keeps a named account usable beside it, so the turn still runs", async () => {
		const seen: Options[] = [];
		configure(await storeWithRawSlots([namelessStoredSlot, cliSlot("work")]), seen);

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(1);
		expect(cliAccountOf(seen[0]?.env)).toBe("work");
		expect(final.stopReason).not.toBe("error");
	});

	it("fails a turn as the actionable unusable-account error, not the crypto TypeError", async () => {
		const seen: Options[] = [];
		configure(await storeWithRawSlots([namelessStoredSlot]), seen);

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(0);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage ?? "").not.toContain("Received undefined");
		expect(final.errorMessage ?? "").toContain("claude_account_unusable");
	});

	it("never refuses when the user configured the ambient lane explicitly", async () => {
		const seen: Options[] = [];
		configure(await storeWithRawSlots([namelessStoredSlot]), seen, {
			anthropicSubscriptionProvider: { tokenInjection: "ambient" },
		});

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(1);
		expect(final.errorMessage ?? "").not.toContain("claude_account_unusable");
	});

	it("never refuses when the ambient lane comes from the environment", async () => {
		const seen: Options[] = [];
		configure(await storeWithRawSlots([namelessStoredSlot]), seen);
		process.env.SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION = "ambient";
		try {
			const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

			expect(seen).toHaveLength(1);
			expect(final.errorMessage ?? "").not.toContain("claude_account_unusable");
		} finally {
			delete process.env.SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION;
		}
	});

	it("names the missing accounts for an explicitly managed lane instead of throwing", async () => {
		const seen: Options[] = [];
		configure(await storeWithRawSlots([namelessStoredSlot]), seen, {
			anthropicSubscriptionProvider: { tokenInjection: "config-dir" },
		});

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(0);
		expect(final.errorMessage ?? "").not.toContain("Received undefined");
		expect(final.errorMessage ?? "").toContain("No Anthropic Subscription accounts configured");
	});

	it("keeps a credential whose only stored entries are legacy token slots on the ambient path", async () => {
		const seen: Options[] = [];
		configure(
			await storeWithRawSlots([{ name: "legacy", source: "login", access: "a", refresh: "r", expires: 1 }]),
			seen,
		);

		const final = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();

		expect(seen).toHaveLength(1);
		expect(final.errorMessage ?? "").not.toContain("claude_account_unusable");
	});

	it("refuses to hash a seat for a nameless account with a named error", () => {
		expect(() => seatDigest(undefined as unknown as string)).toThrow(/claude_account_unusable/);
	});
});
