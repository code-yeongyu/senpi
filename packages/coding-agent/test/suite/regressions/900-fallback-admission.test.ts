import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Context, FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";
import { modelSwitchMarker } from "../../../src/core/model-switch-marker.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

// Derived from the note itself (the shared head of its fallback and fallback-ended texts), so rewording
// the note cannot silently re-route these tests.
const MODEL_SWITCH_NOTE_PREFIX = commonPrefix(
	String(modelSwitchMarker({ from: "a", to: "b", reason: "fallback" }).content),
	String(modelSwitchMarker({ from: "a", to: "b", reason: "fallback-revert" }).content),
);

function commonPrefix(left: string, right: string): string {
	let index = 0;
	while (index < left.length && left[index] === right[index]) index++;
	return left.slice(0, index);
}

function lastUser(context: Context): string {
	const message = context.messages.findLast(
		(message) => message.role === "user" && !getMessageText(message).startsWith(MODEL_SWITCH_NOTE_PREFIX),
	);
	return message ? getMessageText(message) : "";
}

// #900: a tiny candidate prefix must not pre-empt the provider fallback.
it.each(["user", "custom"])("preserves %s fallback before engagement below one ceiling block", async (source) => {
	harness = await createHarness({
		models: [
			{ id: "faux-1", contextWindow: 50_000, maxTokens: 2_048 },
			{ id: "faux-2", contextWindow: 50_000, maxTokens: 2_048 },
		],
		settings: {
			compaction: { enabled: true, reserveTokens: 5_000, keepRecentTokens: 32, speculativeEnabled: false },
			retry: {
				enabled: true,
				maxRetries: 0,
				baseDelayMs: 1,
				fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
			},
		},
		extensionFactories: [compactionExtension],
	});
	for (let index = 0; index < 6; index++) {
		harness.sessionManager.appendMessage({ role: "user", content: "Small earlier request", timestamp: index });
	}
	harness.sessionManager.appendMessage({ role: "user", content: "history ".repeat(22_000), timestamp: 6 });
	const assistant = fauxAssistantMessage("result ".repeat(200), { timestamp: 7 });
	harness.sessionManager.appendMessage({
		...assistant,
		usage: { ...assistant.usage, input: 19_900, output: 100, totalTokens: 20_000 },
	});
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const response: FauxResponseFactory = async (context, _options, _state, model) => {
		if (lastUser(context) === "trigger fallback") {
			return model.id === "faux-1"
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })
				: fauxAssistantMessage("fallback answer");
		}
		return fauxAssistantMessage("compacted on active fallback");
	};
	harness.setResponses([response, response, response, response]);
	if (source === "custom") {
		await harness.session.sendCustomMessage(
			{ customType: "synthetic-prompt", content: "trigger fallback", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();
	} else {
		await harness.session.prompt("trigger fallback");
	}
	expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: "faux/faux-1", to: "faux/faux-2" }]);
	const requests = harness.faux.getCallLog();
	expect(requests.filter((call) => lastUser(call.context) === "trigger fallback").map((call) => call.modelId)).toEqual(
		["faux-1", "faux-2"],
	);
	expect(requests.filter((call) => lastUser(call.context) !== "trigger fallback").map((call) => call.modelId)).toEqual(
		["faux-2"],
	);
	expect(harness.session.model?.id).toBe("faux-2");
});
