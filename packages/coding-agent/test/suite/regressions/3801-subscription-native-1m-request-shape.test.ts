import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { anthropicSubscriptionModels } from "../../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	_resetLongContextForTesting,
	longContextAvailable,
	markLongContextRefused,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import type { AnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";

const NATIVE = ["claude-fable-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-7", "claude-opus-5"] as const;
const LEGACY = ["claude-opus-4-6", "claude-sonnet-4-6"] as const;
const REFUSAL =
	"Extra usage is required for long context · enable extra usage at claude.ai/settings/usage (rate_limit)";
let directory: string;
let statePath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-3801-"));
	statePath = join(directory, "long-context.json");
	_resetLongContextForTesting(statePath);
});

afterEach(() => {
	_resetLongContextForTesting();
	resetAuthLaneBoundary();
	rmSync(directory, { recursive: true, force: true });
});

function catalogModel(id: string): Model<Api> {
	const model = getModels("anthropic").find((candidate) => candidate.id === id);
	if (!model) throw new Error(`${id} is not in the anthropic catalog`);
	return model as Model<Api>;
}

function requestOptions(id: string, providerSettings: AnthropicSubscriptionProviderSettings = {}): Options {
	return buildAnthropicSubscriptionQueryOptions({
		model: catalogModel(id),
		context: { messages: [] },
		cwd: directory,
		providerSettings,
		authLane: "oauth-slots",
	});
}

function plannedWindow(id: string, longContext: boolean): number | undefined {
	return anthropicSubscriptionModels(longContext).find((model) => model.id === id)?.contextWindow;
}

describe("#3801: native-1M models are requested by their plain id with the window senpi plans", () => {
	it.each(NATIVE)("%s: plain id, CLAUDE_CODE_MAX_CONTEXT_TOKENS = catalog window, DISABLE_COMPACT", (id) => {
		const window = catalogModel(id).contextWindow;

		const before = requestOptions(id);
		markLongContextRefused();
		const afterRefusal = requestOptions(id);

		for (const options of [before, afterRefusal]) {
			expect(options.model).toBe(id);
			expect(options.env).toMatchObject({
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window),
				DISABLE_COMPACT: "1",
			});
		}
	});

	it.each(NATIVE)("%s: the planning window stays at the catalog window after a refusal", (id) => {
		expect(plannedWindow(id, false)).toBe(catalogModel(id).contextWindow);
	});

	it.each(LEGACY)("%s: [1m] opt-in while available, the plain id and 200k after a refusal", (id) => {
		const available = requestOptions(id);
		markLongContextRefused();
		const refused = requestOptions(id);

		expect(available.model).toBe(`${id}[1m]`);
		expect(available.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
		expect(refused.model).toBe(id);
		expect(refused.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("200000");
		expect(plannedWindow(id, false)).toBe(200_000);
	});

	it("leaves Claude Code's own compaction alone when the SDK owns compaction", () => {
		const options = requestOptions("claude-fable-5", { compactionOwner: "sdk" });

		expect(options.model).toBe("claude-fable-5");
		expect(options.env?.DISABLE_COMPACT).toBeUndefined();
		expect(options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
	});
});

describe("#3801: a refusal recorded before the fix does not outlive it", () => {
	it("ignores and removes an unversioned refusal, so 1M comes back on the next request", () => {
		writeFileSync(statePath, `${JSON.stringify({ refusedUntil: Date.now() + 60 * 60_000 })}\n`);
		_resetLongContextForTesting(statePath);

		expect(longContextAvailable()).toBe(true);
		expect(existsSync(statePath)).toBe(false);
		expect(requestOptions("claude-fable-5").env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
		expect(requestOptions("claude-opus-4-6").model).toBe("claude-opus-4-6[1m]");
	});

	it("still holds a refusal recorded by this version across processes", () => {
		markLongContextRefused();
		_resetLongContextForTesting(statePath);

		expect(longContextAvailable()).toBe(false);
		expect(requestOptions("claude-opus-4-6").model).toBe("claude-opus-4-6");
		expect(requestOptions("claude-fable-5").model).toBe("claude-fable-5");
	});
});

/** Answers the first query with the long-context refusal and every later one with success. */
function refusingOnce(models: Array<string | undefined>): SdkQuery {
	return (input) => {
		models.push(input.options?.model);
		const refuse = models.length === 1;
		const handle: SdkQueryHandle = {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield (refuse
					? { type: "result", subtype: "error_during_execution", is_error: true, errors: [REFUSAL] }
					: { type: "result", subtype: "success", result: "ok" }) as unknown as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
		return handle;
	};
}

async function runTurn(id: string, lane: "ambient" | "oauth-slots"): Promise<Array<string | undefined>> {
	const store = new InMemoryCredentialStore();
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin", ...(lane === "oauth-slots" ? { CLAUDE_CODE_OAUTH_TOKEN: "fake-access" } : {}) }),
		getAgentDir: () => directory,
	});
	const providerSettings: AnthropicSubscriptionProviderSettings = { tokenInjection: lane };
	const models: Array<string | undefined> = [];
	try {
		for await (const _message of queryWithAuthLane({
			prompt: "hi",
			query: refusingOnce(models),
			buildOptions: (authLane) =>
				buildAnthropicSubscriptionQueryOptions({
					model: catalogModel(id),
					context: { messages: [] },
					cwd: directory,
					providerSettings,
					authLane,
				}),
			providerSettings,
			model: id,
		})) {
			if (_message.type === "result") break;
		}
	} catch {
		// A native model's refusal is an ordinary failure of the turn.
	}
	return models;
}

describe("#3801: only a legacy [1m] request enters the long-context refusal fallback", () => {
	it.each(["ambient", "oauth-slots"] as const)("%s lane: a native model is never retried at 200k", async (lane) => {
		const models = await runTurn("claude-fable-5", lane);

		expect(models).toEqual(["claude-fable-5"]);
		expect(longContextAvailable()).toBe(true);
	});

	it.each(["ambient", "oauth-slots"] as const)("%s lane: a legacy model retries once without [1m]", async (lane) => {
		const models = await runTurn("claude-opus-4-6", lane);

		expect(models).toEqual(["claude-opus-4-6[1m]", "claude-opus-4-6"]);
		expect(longContextAvailable()).toBe(false);
	});
});
