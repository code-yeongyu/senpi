import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { applyRetryFallbackProfile } from "../../../src/core/agent-session-runtime.ts";
import { environmentFailure } from "../../../src/core/retry-fallback/environment-failure.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

const failure = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

const UNSCOPED_KEY =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace"}}';
const CHATGPT_LIMIT = "The chatgpt-subscription account usage limit has been reached";

const MISSING_CLAUDE_CODE = [
	"Claude Code executable not found for win32-x64. Tried:",
	"  - @anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
	"  - claude on PATH",
].join("\n");

async function chainedHarness(harnesses: Harness[], maxRetries: number): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: () => 0,
		settings: {
			retry: { enabled: true, baseDelayMs: 1, maxRetries, fallbackChains: { [primary]: [fallback] } },
		},
	});
	harnesses.push(harness);
	return harness;
}

describe("desktop#3464 environment failures never fall back", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([
		["a missing Claude Code binary", MISSING_CLAUDE_CODE],
		["a rejected credential", "401 Unauthorized: invalid x-api-key"],
		["a dead network past the retry budget", "TypeError: fetch failed (ECONNRESET): connection reset by peer"],
	])("#given %s #when the turn fails #then it stops on the primary with one error", async (_label, errorMessage) => {
		const harness = await chainedHarness(harnesses, 1);
		harness.setResponses([failure(errorMessage), failure(errorMessage), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("weather today");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(new Set(harness.faux.getCallLog().map((call) => call.modelId))).toEqual(new Set(["faux-1"]));
		expect(harness.session.model?.id).toBe("faux-1");
		const errors = harness.session.messages.filter(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		expect(errors.at(-1)).toMatchObject({ errorMessage });
	});

	it("#given a task child whose fallback lands on an unscoped API key #when that key is refused #then the chain stops there", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fallbackNow: () => 0,
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 } },
		});
		harnesses.push(harness);
		// The account limit spends the whole primary provider, so the chain moves to another one (an API key).
		registerFallbackModels(harness, "api-key", ["faux-2", "faux-3"]);
		// The chain a task child gets from its open_session, applied the way the RPC host applies it.
		applyRetryFallbackProfile(harness.settingsManager, {
			modelFallback: true,
			fallbackChains: { [primary]: ["api-key/faux-2", "api-key/faux-3"] },
		});
		harness.setResponses([failure(CHATGPT_LIMIT), failure(UNSCOPED_KEY), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("child task");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: "api-key/faux-2" }]);
		const errors = harness.session.messages.filter(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		expect(errors.at(-1)).toMatchObject({ errorMessage: UNSCOPED_KEY });
	});

	it("#given a model overload #when the turn fails #then the chain still falls back", async () => {
		const harness = await chainedHarness(harnesses, 0);
		harness.setResponses([failure("overloaded_error: Overloaded"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("weather today");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: fallback }]);
	});
});

describe("environmentFailure", () => {
	it.each([
		[MISSING_CLAUDE_CODE, "executable"],
		["Claude Code native binary not found at C:\\Users\\u\\AppData\\Roaming\\npm\\claude.exe", "executable"],
		["spawn claude ENOENT", "executable"],
		["'claude' is not recognized as an internal or external command", "executable"],
		["401 Unauthorized", "auth"],
		["authentication_error: invalid x-api-key", "auth"],
		["OAuth token has expired. Please run /login", "auth"],
		[UNSCOPED_KEY, "auth"],
		["400 invalid_request_error: workspace not found for this API key", "auth"],
		["getaddrinfo ENOTFOUND api.example.test", "network"],
	])("#given %s #then it is an environment failure of kind %s", (message, kind) => {
		expect(environmentFailure(message)).toBe(kind);
	});

	it.each([
		"429 Too Many Requests: rate limit reached",
		"overloaded_error: Overloaded",
		"403 permission_error: your organization does not have access to this model",
		"model not found: claude-opus-9",
		CHATGPT_LIMIT,
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
		"You have hit your usage limit. Resets in 9 minutes",
		undefined,
	])("#given %s #then it is the model's failure, not the environment's", (message) => {
		expect(environmentFailure(message)).toBeUndefined();
	});
});
