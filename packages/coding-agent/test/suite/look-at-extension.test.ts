import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import lookAtExtension from "../../src/core/extensions/builtin/look-at/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const TOOL_NAME = "look_at";
const MODEL_EVENT_TIMEOUT_MS = 1_000;
const harnesses: Harness[] = [];
const modelSelectionProbes = new WeakMap<Harness, ReturnType<typeof createModelSelectionProbe>>();

function textOnly(id: string): FauxModelDefinition {
	return { id, input: ["text"] };
}

function vision(id: string): FauxModelDefinition {
	return { id, input: ["text", "image"] };
}

function composedVision(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function createModelSelectionProbe() {
	const listeners = new Map<string, Set<() => void>>();
	return {
		extension(pi: ExtensionAPI): void {
			pi.on("model_select", (event) => {
				for (const listener of listeners.get(event.model.id) ?? []) listener();
			});
		},
		waitFor(modelId: string): Promise<void> {
			return new Promise((resolve, reject) => {
				const listener = () => {
					clearTimeout(timeout);
					listeners.get(modelId)?.delete(listener);
					resolve();
				};
				const timeout = setTimeout(() => {
					listeners.get(modelId)?.delete(listener);
					reject(new Error(`Timed out waiting for model_select to ${modelId}.`));
				}, MODEL_EVENT_TIMEOUT_MS);
				const pending = listeners.get(modelId) ?? new Set<() => void>();
				pending.add(listener);
				listeners.set(modelId, pending);
			});
		},
	};
}

async function createLookAtHarness(options: HarnessOptions = {}): Promise<Harness> {
	const {
		models = [textOnly("main"), vision("vision")],
		extensionFactories = [],
		settings,
		...harnessOptions
	} = options;
	const probe = createModelSelectionProbe();
	const harness = await createHarness({
		...harnessOptions,
		models,
		settings: { ...settings, images: { autoResize: false, ...settings?.images } },
		extensionFactories: [lookAtExtension, ...extensionFactories, probe.extension],
	});
	harnesses.push(harness);
	modelSelectionProbes.set(harness, probe);
	await harness.session.bindExtensions({});
	return harness;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function selectModel(harness: Harness, modelId: string): Promise<void> {
	const model = harness.getModel(modelId);
	const probe = modelSelectionProbes.get(harness);
	if (!model || !probe) throw new Error(`Missing look_at model selection setup for: ${modelId}`);
	const selected = probe.waitFor(modelId);
	await harness.session.setModel(model);
	await selected;
}

function completedStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: { ...message, content: [] } });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

describe("look_at extension integration", () => {
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("round-trips gating across non-vision and vision model selections", async () => {
		const harness = await createLookAtHarness();

		expect(harness.session.getActiveToolNames()).toContain(TOOL_NAME);
		await selectModel(harness, "vision");
		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_NAME);
		await expect(harness.session.executeTool(TOOL_NAME, { image_data: PNG, goal: "describe" })).rejects.toMatchObject(
			{
				code: "inactive_tool",
			},
		);
		await selectModel(harness, "main");
		expect(harness.session.getActiveToolNames()).toContain(TOOL_NAME);
	});

	it("stays inactive when no image-capable model is available", async () => {
		const harness = await createLookAtHarness({ models: [textOnly("main")] });

		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_NAME);
	});

	it("delegates a file fixture to the selected vision model and records its details", async () => {
		const harness = await createLookAtHarness();
		await writeFile(join(harness.tempDir, "fixture.png"), Buffer.from(PNG, "base64"));
		harness.setResponses([fauxAssistantMessage("The fixture is a one-pixel PNG.")]);

		const result = await harness.session.executeTool<{ model: string; sources: string[]; mimeTypes: string[] }>(
			TOOL_NAME,
			{
				file_path: "fixture.png",
				goal: "Describe the fixture",
			},
		);

		expect(resultText(result)).toBe("The fixture is a one-pixel PNG.");
		expect(result.details).toEqual({ model: "faux/vision", sources: ["fixture.png"], mimeTypes: ["image/png"] });
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(harness.faux.getCallLog()[0]?.modelId).toBe("vision");
	});

	it("keeps an in-flight call scoped to its execution signal while model_select deactivates the tool", async () => {
		vi.useFakeTimers();
		const harness = await createLookAtHarness();
		let releaseResponse!: () => void;
		const responseReleased = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let resolveStreamStarted!: (signal: AbortSignal | undefined) => void;
		const streamStarted = new Promise<AbortSignal | undefined>((resolve) => {
			resolveStreamStarted = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				resolveStreamStarted(options?.signal);
				await responseReleased;
				return fauxAssistantMessage("late vision result");
			},
		]);
		const toolController = new AbortController();
		const execution = harness.session.executeTool(
			TOOL_NAME,
			{ image_data: PNG, goal: "describe" },
			{
				signal: toolController.signal,
			},
		);
		const requestSignal = await streamStarted;

		await selectModel(harness, "vision");
		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_NAME);
		expect(requestSignal).not.toBe(toolController.signal);
		expect(requestSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(119_999);
		expect(requestSignal?.aborted).toBe(false);
		toolController.abort();
		expect(requestSignal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(requestSignal?.aborted).toBe(true);
		releaseResponse();

		expect(resultText(await execution)).toBe("look_at analysis was aborted.");
	});

	it("dispatches through the composed provider instead of the global compat faux decoy", async () => {
		const api = "look-at-composed" as Api;
		const composedStream = vi.fn((model: Model<Api>) => completedStream(model, "composed provider result"));
		const harness = await createLookAtHarness({
			api,
			provider: "global-decoy",
			models: [textOnly("main")],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerProvider("composed", {
						api,
						apiKey: "composed-faux-key",
						baseUrl: "http://composed.invalid/v1",
						models: [composedVision("composed-vision")],
						streamSimple: composedStream,
					});
				},
			],
		});

		const result = await harness.session.executeTool(TOOL_NAME, { image_data: PNG, goal: "describe" });

		expect(resultText(result)).toBe("composed provider result");
		expect(composedStream).toHaveBeenCalledTimes(1);
		expect(composedStream.mock.calls[0]?.[0]).toMatchObject({ provider: "composed", id: "composed-vision" });
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("excludes a vision candidate belonging to an unconfigured faux provider", async () => {
		const harness = await createLookAtHarness({ withConfiguredAuth: false });

		expect(harness.getExtensionRunner().getModelRegistry().getAvailable()).toEqual([]);
		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_NAME);
	});

	it("surfaces image input errors through the active extension tool", async () => {
		const standard = await createLookAtHarness({ settings: { images: { autoResize: false } } });
		const missing = await standard.session.executeTool(TOOL_NAME, { file_path: "missing.png", goal: "describe" });
		const aggregateImage = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(9 * 1024 * 1024)]).toString(
			"base64",
		);
		const aggregate = await standard.session.executeTool(TOOL_NAME, {
			image_data_list: [aggregateImage, aggregateImage, aggregateImage],
			goal: "describe",
		});
		const unknown = await standard.session.executeTool(TOOL_NAME, {
			image_data: Buffer.from("unknown media").toString("base64"),
			goal: "describe",
		});
		const blocked = await createLookAtHarness({ settings: { images: { blockImages: true } } });
		const blockedResult = await blocked.session.executeTool(TOOL_NAME, { image_data: PNG, goal: "describe" });

		expect(resultText(missing)).toContain("Error: File not found: missing.png");
		expect(resultText(aggregate)).toContain("25MiB aggregate limit");
		expect(resultText(unknown)).toContain("Could not determine MIME type");
		expect(resultText(blockedResult)).toContain("Image inputs are blocked by settings");
	});
});
