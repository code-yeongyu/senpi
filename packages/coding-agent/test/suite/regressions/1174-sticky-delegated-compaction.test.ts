import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import type { InlineExtension } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function externallyOwnedCompaction(attempts: string[]): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", (event) => {
			attempts.push(event.reason);
			return {
				cancel: true,
				rejectionCause: "external-owner",
				reason: "provider lane owns compaction",
			};
		});
	}) as InlineExtension;
}

async function createOverThresholdHarness(attempts: string[]): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{ id: "faux-large", contextWindow: 20_000, maxTokens: 4_096 },
			{ id: "faux-large-next", contextWindow: 20_000, maxTokens: 4_096 },
		],
		settings: { compaction: { reserveTokens: 1_000, speculativeEnabled: false } },
		extensionFactories: [externallyOwnedCompaction(attempts)],
	});
	harnesses.push(harness);
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "work through the todo list" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("progress note ".concat("x".repeat(80_000)), { timestamp }),
		usage: {
			input: 19_500,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 19_500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

async function createOverThresholdHarnessWithResourceLoader(
	resourceLoader: ReturnType<typeof createTestResourceLoader>,
): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{ id: "faux-large", contextWindow: 25_000, maxTokens: 4_096 },
			{ id: "faux-large-next", contextWindow: 25_000, maxTokens: 4_096 },
		],
		settings: { compaction: { reserveTokens: 1_000, speculativeEnabled: false } },
		resourceLoader,
	});
	harnesses.push(harness);
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "work through the todo list" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("progress note ".concat("x".repeat(80_000)), { timestamp }),
		usage: {
			input: 19_500,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 19_500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

function privateSessionMethod(session: Harness["session"], name: string): (...args: unknown[]) => unknown {
	const method: unknown = Reflect.get(session, name);
	if (typeof method !== "function") throw new Error(`Expected AgentSession.${name}`);
	return method.bind(session);
}

describe("issue #1174: delegated compaction stays sticky per model", () => {
	it("stops auto attempts, preserves manual attempts, and re-arms after a model change", async () => {
		const attempts: string[] = [];
		const harness = await createOverThresholdHarness(attempts);
		harness.setResponses([
			fauxAssistantMessage("first turn continued"),
			fauxAssistantMessage("second turn continued"),
			fauxAssistantMessage("model-switched turn continued"),
		]);

		await harness.session.prompt("first turn");
		expect(attempts).toEqual(["pre_prompt"]);

		await harness.session.prompt("second turn");
		expect(attempts).toEqual(["pre_prompt"]);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === false)).toHaveLength(1);

		await expect(harness.session.compact()).rejects.toThrow("active provider owns compaction");
		expect(attempts).toEqual(["pre_prompt", "manual"]);

		const nextModel = harness.getModel("faux-large-next");
		if (!nextModel) throw new Error("Expected second faux model");
		await harness.session.setSessionModel(nextModel);
		await harness.session.prompt("turn after model change");
		expect(attempts).toEqual(["pre_prompt", "manual", "overflow"]);
	});

	it("re-arms automatic compaction after reload removes the external owner", async () => {
		const attempts: string[] = [];
		const owner = externallyOwnedCompaction(attempts);
		const extensionResult = await createTestExtensionsResult([owner]);
		let activeExtensions = extensionResult;
		const resourceLoader = createTestResourceLoader({ extensionsResult: activeExtensions });
		const harness = await createOverThresholdHarnessWithResourceLoader(resourceLoader);

		await privateSessionMethod(harness.session, "_runPrePromptCompaction")(
			harness.session.agent.state.messages.findLast((message) => message.role === "assistant"),
			false,
			"pre_prompt",
		);
		expect(attempts).toEqual(["pre_prompt"]);

		activeExtensions = await createTestExtensionsResult([]);
		(resourceLoader as { getExtensions: () => typeof activeExtensions }).getExtensions = () => activeExtensions;
		await harness.session.reload();
		expect(harness.session.hasExtensionHandlers("session_before_compact")).toBe(false);
		const startsBeforeRetry = harness.eventsOfType("compaction_start").length;
		const runAutoCompaction = privateSessionMethod(harness.session, "_runAutoCompaction");
		await runAutoCompaction("threshold", false);

		expect(attempts).toEqual(["pre_prompt"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(startsBeforeRetry + 1);
	});
});
