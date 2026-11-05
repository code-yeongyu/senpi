import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createPicoModels } from "../../../src/experimental/micro/models.ts";
import type { Harness } from "../harness.ts";
import { captureSdkRequests, cleanupSdkPaths, sdkPathHarness } from "./2848-sdk-cwd-fixture.ts";

afterEach(() => {
	cleanupSdkPaths();
});

async function compactionSummary(harness: Harness): Promise<void> {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("assistant response to compact"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 2,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to keep" }],
		timestamp: 3,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const result = await harness.session.compact();
	// A summary from the model, not the deterministic fallback that drops older context.
	expect(result.summary).toContain("Cwd Fixture Answer");
}

async function microTurn(harness: Harness): Promise<void> {
	const models = createPicoModels(harness.modelRegistry.modelRuntime, new Map(), harness.session.cwd);
	const events: string[] = [];
	for await (const event of models.stream(
		harness.getModel(),
		{ messages: [{ role: "user", content: "hello", timestamp: 1 }], thinkingLevel: "off" },
		BACKGROUND_CONTEXT,
	)) {
		events.push(event.type);
	}
	expect(events.at(-1)).toBe("done");
}

// senpi#4393: request paths outside the session factory's streamFn must carry the
// session cwd themselves, or the Claude SDK provider refuses the request before sending it.
describe("senpi#4393 Claude SDK callers outside the session factory", () => {
	it.each([
		["compaction summary", [compactionExtension], compactionSummary],
		["micro model adapter", [], microTurn],
	] as const)("passes the session cwd to the SDK for the %s", async (_name, extensions, run) => {
		const captured = captureSdkRequests();
		const harness = await sdkPathHarness([...extensions], {
			settings: { compaction: { enabled: true, keepRecentTokens: 1 }, images: { autoResize: false } },
		});
		expect(harness.session.cwd).not.toBe(process.cwd());

		await run(harness);

		expect(captured.length).toBeGreaterThan(0);
		expect(captured.every((options) => options.cwd === harness.session.cwd)).toBe(true);
	});
});
