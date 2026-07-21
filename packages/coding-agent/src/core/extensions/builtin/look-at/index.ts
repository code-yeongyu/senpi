import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { LOOK_AT_PARAMETERS, normalizeLookAtArgs, prepareLookAtArguments, validateLookAtArgs } from "./arguments.ts";
import { registerLookAtCommand } from "./commands.ts";
import { resolveVisionModel } from "./model-selector.ts";
import { LOOK_AT_DESCRIPTION, LOOK_AT_PROMPT_SNIPPET } from "./prompts.ts";
import { type LookAtToolDetails, renderLookAtCall, renderLookAtResult } from "./render.ts";
import { runLookAt } from "./runner.ts";
import { createLookAtStore, loadLookAtChain, loadLookAtEnabled } from "./settings.ts";

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
		syncToolActivation(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		syncToolActivation(ctx);
	});

	registerLookAtCommand(pi, {
		store,
		loadChain: (ctx) => loadLookAtChain(ctx, store),
		resync: (ctx) => syncToolActivation(ctx),
	});
}
