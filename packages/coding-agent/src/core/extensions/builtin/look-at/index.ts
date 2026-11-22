import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { LOOK_AT_PARAMETERS, normalizeLookAtArgs, prepareLookAtArguments, validateLookAtArgs } from "./arguments.ts";
import { registerLookAtCommand } from "./commands.ts";
import { startHookDeadlineBudget } from "./hook-deadline-budget.ts";
import { replaceImagesNamingTool } from "./image-placeholder.ts";
import { resolveVisionModel } from "./model-selector.ts";
import { LOOK_AT_DESCRIPTION, LOOK_AT_PROMPT_SNIPPET, TOOL_IMAGE_DESCRIPTION_GOAL } from "./prompts.ts";
import { type LookAtToolDetails, renderLookAtCall, renderLookAtResult } from "./render.ts";
import { runLookAt } from "./runner.ts";
import { createLookAtStore, loadLookAtChain, loadLookAtEnabled } from "./settings.ts";
import { describeToolResultImages } from "./tool-result-images.ts";

const TOOL_NAME = "look_at";

export default function lookAtExtension(pi: ExtensionAPI): void {
	const store = createLookAtStore();

	pi.registerTool<typeof LOOK_AT_PARAMETERS, LookAtToolDetails>({
		name: TOOL_NAME,
		label: "Look At",
		description: LOOK_AT_DESCRIPTION,
		promptSnippet: LOOK_AT_PROMPT_SNIPPET,
		parameters: LOOK_AT_PARAMETERS,
		prepareArguments: prepareLookAtArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const normalized = normalizeLookAtArgs(params);
			const validationError = validateLookAtArgs(normalized);
			if (validationError) throw new Error(validationError);

			const result = await runLookAt(normalized, signal, ctx, store);
			return {
				content: [{ type: "text", text: result.text }],
				details: { model: result.model, sources: result.sources, mimeTypes: result.mimeTypes },
			};
		},
		renderCall: renderLookAtCall,
		renderResult: renderLookAtResult,
	});

	function syncToolActivation(ctx: ExtensionContext): void {
		const active = pi.getActiveTools();
		const shouldBeActive =
			loadLookAtEnabled(ctx, store) &&
			ctx.model !== undefined &&
			!ctx.model.input.includes("image") &&
			resolveVisionModel(loadLookAtChain(ctx, store), ctx.modelRegistry.getAvailable()) !== undefined;
		const isActive = active.includes(TOOL_NAME);
		if (shouldBeActive && !isActive) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!shouldBeActive && isActive) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		syncLookAt(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		syncLookAt(ctx);
	});
	// A switch that is held for compaction emits model_select and then restores the previous model without an
	// event, so the registration is checked against the active model again before each turn.
	pi.on("turn_start", async (_event, ctx) => {
		syncLookAt(ctx);
	});

	// The tool is named only while the model can call it.
	function offersLookAt(ctx: ExtensionContext): ctx is ExtensionContext & { model: Model<Api> } {
		return ctx.model !== undefined && !ctx.model.input.includes("image") && pi.getActiveTools().includes(TOOL_NAME);
	}

	// With images blocked the transport replaces them itself and look_at refuses every input.
	function describesImagesFor(ctx: ExtensionContext): ctx is ExtensionContext & { model: Model<Api> } {
		return offersLookAt(ctx) && !ctx.getImageSettings().blockImages;
	}

	// Every registered tool_result handler gives each tool call a PostToolUse hook run on the session stream,
	// even one that returns at once, so the describer is registered only while look_at is offered.
	let dropToolResultDescriber: (() => void) | undefined;
	function syncLookAt(ctx: ExtensionContext): void {
		syncToolActivation(ctx);
		if (offersLookAt(ctx)) {
			dropToolResultDescriber ??= registerToolResultDescriber();
		} else {
			dropToolResultDescriber?.();
			dropToolResultDescriber = undefined;
		}
	}

	pi.on(
		"context_with_system",
		(event, ctx) => {
			if (!describesImagesFor(ctx)) return undefined;
			const messages = replaceImagesNamingTool(event.messages, ctx.model, TOOL_NAME);
			return messages === event.messages ? undefined : { messages };
		},
		{ mutatesMessages: false },
	);

	// Runs once per tool call, before the result is stored: the description takes the image's place in
	// the transcript and no later request describes it again. An image that could not be described
	// stays in the result and gets the placeholder above.
	const registerToolResultDescriber = () =>
		pi.on("tool_result", async (event, ctx) => {
			// A nested call's result goes to the tool that issued it, not to the model.
			if (event.parentToolCallId !== undefined || !Array.isArray(event.content) || !describesImagesFor(ctx)) {
				return undefined;
			}
			const budget = startHookDeadlineBudget(ctx.signal);
			const { content, failures } = await describeToolResultImages(event.content, TOOL_NAME, async (image) => {
				ctx.updateToolHookStatus?.("look_at: describing image");
				const result = await runLookAt(
					{ image_data_list: [`data:${image.mimeType};base64,${image.data}`], goal: TOOL_IMAGE_DESCRIPTION_GOAL },
					budget.signal,
					ctx,
					store,
				);
				return { model: result.model, text: result.text };
			}).finally(budget.dispose);
			if (failures.length > 0 && !ctx.signal?.aborted) {
				const reasons = [...new Set(failures)].join("; ");
				ctx.ui.notify(`look_at could not describe an image from ${event.toolName}: ${reasons}`, "warning");
			}
			if (!content) return undefined;
			return {
				content,
				...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
			};
		});

	registerLookAtCommand(pi, {
		store,
		loadChain: (ctx) => loadLookAtChain(ctx, store),
		resync: (ctx) => syncLookAt(ctx),
	});
}
