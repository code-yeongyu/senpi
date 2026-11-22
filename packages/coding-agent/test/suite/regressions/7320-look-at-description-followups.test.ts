import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
	type Message,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import lookAtExtension from "../../../src/core/extensions/builtin/look-at/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, getToolResult, type Harness } from "../harness.ts";

// senpi#7320: review findings on #7260. The placeholder for a pasted image asked for a file path the
// image does not have, the description of a tool-result image could outlive the hook that asked for
// it, and a held model switch left look_at registered for the model that did not take effect.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const TOOL_NAME = "look_at";
const DESCRIPTION = "A single dark pixel on a transparent background.";
const TEXT_ONLY: FauxModelDefinition = { id: "main", input: ["text"] };
const VISION: FauxModelDefinition = { id: "vision", input: ["text", "image"] };
const harnesses: Harness[] = [];

async function createLookAtHarness(
	models: FauxModelDefinition[],
	extensionFactories: Array<(pi: ExtensionAPI) => void> = [],
): Promise<Harness> {
	const harness = await createHarness({
		models,
		settings: { images: { autoResize: false } },
		extensionFactories: [lookAtExtension, ...extensionFactories],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	await writeFile(join(harness.tempDir, "shot.png"), Buffer.from(PNG, "base64"));
	return harness;
}

function call(toolName: string, args: ToolCall["arguments"] = {}) {
	return fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" });
}

function png(): ImageContent {
	return { type: "image", data: PNG, mimeType: "image/png" };
}

function requestsTo(harness: Harness, modelId: string): Context[] {
	return harness.faux
		.getCallLog()
		.filter((entry) => entry.modelId === modelId)
		.map((entry) => entry.context);
}

function lastMessage(context: Context | undefined, role: Message["role"]): Message {
	const message = context?.messages.findLast((candidate) => candidate.role === role);
	if (!message) throw new Error(`The request carried no ${role} message.`);
	return message;
}

function textOf(message: Message): string {
	if (!Array.isArray(message.content)) return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function hasImage(message: Message): boolean {
	return Array.isArray(message.content) && message.content.some((block) => block.type === "image");
}

function postToolUseRuns(harness: Harness) {
	return harness.eventsOfType("tool_hook_status").filter((event) => event.hookName === "PostToolUse");
}

/** A model-specific system prompt, as a prompt preset returns from `model_select`, too large to fit beside the seeded transcript. */
function largePromptFor(modelId: string) {
	return (pi: ExtensionAPI) => {
		pi.on("model_select", (event) =>
			event.model.id === modelId ? { systemPrompt: "large ".repeat(100_000) } : undefined,
		);
	};
}

function seedLiveContext(harness: Harness, tokens: number): void {
	const model = harness.getModel();
	const timestamp = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "context ".repeat(30_000) }],
		timestamp,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: timestamp + 1,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/**
 * Selects `targetId`. It fits until its `model_select` prompt is applied, so the switch emits `model_select`,
 * is held for compaction and rolls back to the current model. Selecting the current model again drops the hold.
 */
async function rollBackSwitchTo(harness: Harness, targetId: string): Promise<void> {
	const current = harness.getModel();
	const target = harness.getModel(targetId);
	if (!target) throw new Error(`missing ${targetId} fixture`);
	seedLiveContext(harness, 200_000);
	await harness.session.setModel(target);
	expect(harness.session.pendingModelSwitch?.model.id).toBe(targetId);
	expect(harness.session.model?.id).toBe(current.id);
	await harness.session.setModel(current);
	expect(harness.session.pendingModelSwitch).toBeUndefined();
	expect(harness.session.model?.id).toBe(current.id);
}

describe("look_at follow-ups to #7260 (senpi#7320)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// The `[Image #N]` reference is look_at's argument syntax for an attached image: the model copies it
	// into the call, so the placeholder of a pasted image has to offer it rather than a file path.
	it("offers a pasted image's attachment reference, and look_at resolves it", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		harness.setResponses([
			(context) =>
				textOf(lastMessage(context, "user")).includes("[Image #N]")
					? call(TOOL_NAME, { file_path: "[Image #1]", goal: "What does it show?" })
					: fauxAssistantMessage("the placeholder offered no reference"),
			fauxAssistantMessage(DESCRIPTION),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("what is this", { images: [png()] });

		const visionRequests = requestsTo(harness, "vision");
		expect(visionRequests).toHaveLength(1);
		expect(hasImage(lastMessage(visionRequests[0], "user"))).toBe(true);
		expect(textOf(getToolResult(harness, TOOL_NAME))).toContain(DESCRIPTION);
	});

	it("aborts the description request before the host stops waiting on the hook", async () => {
		vi.stubEnv("SENPI_TOOL_RESULT_HANDLER_TIMEOUT_MS", "1000");
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const started = Promise.withResolvers<AbortSignal | undefined>();
		const released = Promise.withResolvers<void>();
		harness.setResponses([
			call("read", { path: "shot.png" }),
			async (_context, options) => {
				started.resolve(options?.signal);
				await Promise.race([
					released.promise,
					new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true })),
				]);
				return fauxAssistantMessage("late description");
			},
			fauxAssistantMessage("done"),
		]);
		const turn = harness.session.prompt("read shot.png");
		const signal = await started.promise;
		expect(signal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1000);

		expect(signal?.aborted).toBe(true);
		released.resolve();
		await turn;
		expect(hasImage(getToolResult(harness, "read"))).toBe(true);
	});

	it("keeps describing tool-result images after a switch to a vision model is rolled back", async () => {
		const harness = await createLookAtHarness(
			[
				{ ...TEXT_ONLY, contextWindow: 1_000_000, maxTokens: 32_000 },
				{ ...VISION, contextWindow: 372_000, maxTokens: 32_000 },
			],
			[largePromptFor("vision")],
		);
		await rollBackSwitchTo(harness, "vision");
		harness.setResponses([
			call("read", { path: "shot.png" }),
			fauxAssistantMessage(DESCRIPTION),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read shot.png");

		expect(requestsTo(harness, "vision")).toHaveLength(1);
		expect(textOf(getToolResult(harness, "read"))).toContain(DESCRIPTION);
	});

	it("adds no hook run to a vision model's tool call after a switch to a text-only model is rolled back", async () => {
		const harness = await createLookAtHarness(
			[
				{ ...VISION, contextWindow: 1_000_000, maxTokens: 32_000 },
				{ ...TEXT_ONLY, contextWindow: 372_000, maxTokens: 32_000 },
			],
			[largePromptFor("main")],
		);
		await rollBackSwitchTo(harness, "main");
		harness.setResponses([call("read", { path: "shot.png" }), fauxAssistantMessage("done")]);

		await harness.session.prompt("read shot.png");

		expect(hasImage(getToolResult(harness, "read"))).toBe(true);
		expect(postToolUseRuns(harness)).toEqual([]);
	});
});
