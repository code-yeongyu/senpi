#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness } from "../suite/harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const primaryModelId = "faux-1";
const fallbackModelId = "faux-2";

function refusal(text) {
	return fauxAssistantMessage(text, {
		stopReason: "error",
		errorMessage: "misleading_success_output",
		stopDetails: { type: "refusal" },
	});
}

function fail(message) {
	throw new Error(`QA mismatch: ${message}`);
}

const harness = await createHarness({
	models: [{ id: "faux-1", contextWindow: 128_000 }, { id: "faux-2", contextWindow: 128_000 }],
	fallbackNow: () => 0,
	settings: {
		retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
	},
});

try {
	harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);
	await harness.session.prompt("hello");
	if (harness.session.model?.id !== fallbackModelId) fail(`expected fallback model, got ${harness.session.model?.id}`);
	const active = harness.session._retryFallback?.activeState;
	if (!active?.pinned || !active.pinnedByRefusal) fail("refusal fallback was not pinned");

	const firstEntry = harness.sessionManager.getEntries()[0];
	if (!firstEntry) fail("session has no entry for compaction");
	const result = await harness.session.applyCompaction(
		{ summary: "fresh summary", firstKeptEntryId: firstEntry.id, tokensBefore: 42, details: { source: "manual-qa" } },
		{ reason: "extension", expectedRevision: harness.session.getMessageRevision() },
	);
	if (result.applied !== true) fail(`compaction did not apply: ${result.reason}`);
	if (harness.session.model?.id !== primaryModelId) fail(`primary was not restored before next prompt: ${harness.session.model?.id}`);

	const logPath = join(harness.tempDir, "agent", "logs", "fallback.log");
	const log = readFileSync(logPath, "utf8");
	const released = log.indexOf('"event":"refusal_pin_released"');
	const reverted = log.indexOf('"event":"fallback_reverted"');
	if (released < 0) fail("fallback.log lacks refusal_pin_released");
	if (reverted < 0) fail("fallback.log lacks fallback_reverted");
	if (released > reverted) fail("release event occurs after revert event");

	console.log("primary -> fallback (refusal, pinned) -> compaction -> primary");
	console.log(JSON.stringify({
		modelCalls: harness.faux.getCallLog().map((call) => call.modelId),
		compaction: result,
		logEvents: ["refusal_pin_released", "fallback_reverted"],
	}, null, 2));
} finally {
	harness.cleanup();
}
