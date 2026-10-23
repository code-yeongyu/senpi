import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	classifyForRequest,
	sdkFailure,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context-retry.ts";
import {
	_resetLongContextForTesting,
	longContextAvailable,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";

const EXHAUSTED = "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
const REQUIRED =
	"Extra usage is required for long context · enable extra usage at claude.ai/settings/usage (rate_limit)";
const LEGACY = "claude-opus-4-6";
const NATIVE = "claude-opus-5";
let directory: string;
let statePath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-4065-"));
	statePath = join(directory, "long-context.json");
	_resetLongContextForTesting(statePath);
});

afterEach(() => {
	resetAuthLaneBoundary();
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

async function runTurn(
	lane: "ambient" | "oauth-slots",
	id: string,
	body = EXHAUSTED,
	visible = false,
	alwaysRefuse = false,
	standardWindow = false,
) {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () =>
		addAccount(emptyCredential(), {
			name: "main",
			access: "fake-access",
			refresh: "fake-refresh",
			expires: Date.now() + 60 * 60_000,
			source: "login",
		}),
	);
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => directory,
	});
	const model = getModels("anthropic").find((candidate) => candidate.id === id) as Model<Api> | undefined;
	if (!model) throw new Error(`Missing fixture model: ${id}`);
	const attempts: Options[] = [];
	const closed: number[] = [];
	const query: SdkQuery = (input) => {
		const options = input.options;
		if (!options) throw new Error("Expected SDK options");
		attempts.push(options);
		const attempt = attempts.length;
		if (attempt > 1) expect(closed).toContain(attempt - 1);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				if (visible) {
					yield { type: "stream_event", event: { type: "content_block_delta" } } as SDKMessage;
				}
				yield (
					attempt === 1 || alwaysRefuse
						? { type: "result", subtype: "error_during_execution", is_error: true, errors: [body] }
						: { type: "result", subtype: "success", result: "ok" }
				) as SDKMessage;
			},
			async interrupt() {},
			close() {
				closed.push(attempt);
			},
		};
	};
	const messages: SDKMessage[] = [];
	let failure: unknown;
	try {
		for await (const message of queryWithAuthLane({
			prompt: "hi",
			query,
			buildOptions: (authLane) =>
				buildAnthropicSubscriptionQueryOptions({
					model: standardWindow ? { ...model, contextWindow: 200_000 } : model,
					context: { messages: [] },
					cwd: directory,
					providerSettings: { tokenInjection: lane },
					authLane,
				}),
			providerSettings: { tokenInjection: lane },
			model: id,
		})) {
			messages.push(message);
			failure = sdkFailure(message) ?? failure;
		}
	} catch (error) {
		failure = error;
	}
	return { attempts, messages, failure, credential: await store.read("anthropic-subscription") };
}

// senpi#4065: the billing text alone does not prove that the request asked for [1m].
describe.each(["ambient", "oauth-slots"] as const)("%s: extra usage exhaustion", (lane) => {
	it.each([EXHAUSTED, REQUIRED])("retries a refused [1m] request at 200k: %s", async (body) => {
		const result = await runTurn(lane, LEGACY, body);

		expect(result.attempts.map((options) => options.model)).toEqual([`${LEGACY}[1m]`, LEGACY]);
		expect(result.attempts.map((options) => options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS)).toEqual([
			"1000000",
			"200000",
		]);
		expect(result.failure).toBeUndefined();
		expect(result.messages).toEqual([{ type: "result", subtype: "success", result: "ok" }]);
		expect(longContextAvailable()).toBe(false);
		expect(existsSync(statePath)).toBe(true);
		expect(result.credential).not.toHaveProperty("accounts.0.blockReason");
	});

	it.each([NATIVE, LEGACY])("does not retry exhaustion on a plain %s request", async (id) => {
		const result = await runTurn(lane, id, EXHAUSTED, false, false, true);

		expect(result.attempts.map((options) => options.model)).toEqual([id]);
		expect(String(result.failure)).toContain(EXHAUSTED);
		expect(classifyForRequest(result.failure, false)).toEqual({ kind: "billing", retryable: false });
		expect(longContextAvailable()).toBe(true);
		expect(existsSync(statePath)).toBe(false);
	});

	it("does not downgrade after visible content", async () => {
		const result = await runTurn(lane, LEGACY, EXHAUSTED, true);

		expect(result.attempts).toHaveLength(1);
		expect(String(result.failure)).toContain(EXHAUSTED);
		expect(longContextAvailable()).toBe(true);
	});

	it("does not repeat the standard-window retry when billing still fails", async () => {
		const result = await runTurn(lane, LEGACY, EXHAUSTED, false, true);

		expect(result.attempts.map((options) => options.model)).toEqual([`${LEGACY}[1m]`, LEGACY]);
		expect(String(result.failure)).toContain(EXHAUSTED);
	});
});

it("classifies the exact 400 as billing without request context", () => {
	expect(classifySdkError(new Error(EXHAUSTED))).toEqual({ kind: "billing", retryable: false });
});
