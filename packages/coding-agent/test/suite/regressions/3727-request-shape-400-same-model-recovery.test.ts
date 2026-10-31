import { fauxAssistantMessage, type ProviderNativeContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	REQUEST_SHAPE_FAILURE_TEXT,
	REQUEST_SHAPE_RECOVERY_ENTRY_TYPE,
} from "../../../src/core/retry-fallback/request-shape.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

const SEARCH_ID = "srvtoolu_redacted01";
const ORPHAN_400 =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1: `web_search` tool use with id `srvtoolu_redacted01` was found without a corresponding `web_search_tool_result` block"}}';

function serverToolUse(): ProviderNativeContent {
	return {
		type: "providerNative",
		subtype: "server_tool_use",
		raw: { type: "server_tool_use", id: SEARCH_ID, name: "web_search", input: { query: "q" } },
	};
}

function webSearchResult(): ProviderNativeContent {
	return {
		type: "providerNative",
		subtype: "web_search_tool_result",
		raw: { type: "web_search_tool_result", tool_use_id: SEARCH_ID, content: [] },
	};
}

function providerNativeBlocksSent(harness: Harness, call: number): number {
	const entry = harness.faux.getCallLog()[call];
	if (!entry) throw new Error(`missing call ${call}`);
	return entry.context.messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.content)
		.filter((block) => block.type === "providerNative").length;
}

describe("senpi#3727 request-shape 400 recovers on the same model", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(provider = "anthropic"): Promise<Harness> {
		const harness = await createHarness({
			api: "anthropic-messages",
			provider,
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					fallbackChains: { [`${provider}/faux-1`]: ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		return harness;
	}

	it("retries once without provider-native replay and never switches models", async () => {
		// Given: an earlier same-model turn that replays a server web search pair
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
			fauxAssistantMessage("recovered answer"),
		]);
		await harness.session.prompt("search then fetch");
		const answered = harness.session.agent.state.messages.findLast((message) => message.role === "assistant");
		if (answered?.role !== "assistant") throw new Error("missing first answer");
		answered.content.unshift(serverToolUse(), webSearchResult());

		// When: the next turn's request is rejected for its shape
		await harness.session.prompt("continue");

		// Then: the retry stays on faux-1, sends no provider-native replay, and records the note
		const calls = harness.faux.getCallLog();
		expect(calls.map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(providerNativeBlocksSent(harness, 1)).toBeGreaterThan(0);
		expect(providerNativeBlocksSent(harness, 2)).toBe(0);
		expect(
			harness.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === REQUEST_SHAPE_RECOVERY_ENTRY_TYPE),
		).toHaveLength(1);
	});

	it("gives up with one plain error when the stripped retry is rejected too", async () => {
		// Given: a session whose request is rejected twice in a row
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
		]);

		// When: the turn runs
		await harness.session.prompt("hello");

		// Then: two same-model attempts, no fallback, one failed retry end with an action
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		const ends = harness.eventsOfType("auto_retry_end");
		const failed = ends.filter((event) => !event.success);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.finalError).toBe(REQUEST_SHAPE_FAILURE_TEXT);
	});

	it("leaves a gateway's invalid_request_error 400 on the ordinary retry path", async () => {
		// Given: a gateway provider that speaks the Anthropic wire
		const harness = await setup("gateway");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
			fauxAssistantMessage("answer"),
		]);

		// When: the gateway rejects the request
		await harness.session.prompt("hello");

		// Then: no request-shape recovery runs; the ordinary retry handles it
		expect(
			harness.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === REQUEST_SHAPE_RECOVERY_ENTRY_TYPE),
		).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).not.toContain(
			REQUEST_SHAPE_FAILURE_TEXT,
		);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("gives a later prompt its own recovery after a give-up", async () => {
		// Given: one prompt that already gave up
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ORPHAN_400 }),
			fauxAssistantMessage("recovered answer"),
		]);
		await harness.session.prompt("hello");

		// When: the next prompt hits the same rejection
		await harness.session.prompt("again");

		// Then: it is retried once on the same model and recovers
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-1", "faux-1"]);
		expect(harness.eventsOfType("auto_retry_end").filter((event) => !event.success)).toHaveLength(1);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});
});
