import type { Api, Model } from "@earendil-works/pi-ai";
import { createApplyPatchTool } from "./tool.ts";
import type {
	ApplyPatchExtensionAPI,
	ApplyPatchToolsetState,
	ApplyPatchToolVariant,
	ApplyPatchWireMode,
} from "./types.ts";

const APPLY_PATCH_FREEFORM_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);
const APPLY_PATCH_JSON_APIS = new Set<Api>(["openai-completions"]);
const EDIT_TOOL_NAMES = new Set(["write", "edit"]);
const APPLY_PATCH_NAME = "apply_patch";

function isGptId(model: Pick<Model<string>, "api" | "id"> | undefined): model is Pick<Model<string>, "api" | "id"> {
	return model?.id.startsWith("gpt-") ?? false;
}

export function getApplyPatchWireMode(model: Pick<Model<string>, "api" | "id"> | undefined): ApplyPatchWireMode {
	if (!isGptId(model)) return "none";
	if (APPLY_PATCH_FREEFORM_APIS.has(model.api)) return "freeform";
	if (APPLY_PATCH_JSON_APIS.has(model.api)) return "json";
	return "none";
}

export function isOpenAIGptModel(model: Pick<Model<string>, "api" | "id"> | undefined): boolean {
	return getApplyPatchWireMode(model) === "freeform";
}

function hasEditTools(toolNames: string[]): boolean {
	return toolNames.some((toolName) => EDIT_TOOL_NAMES.has(toolName));
}

function withoutApplyPatch(toolNames: string[]): string[] {
	return toolNames.filter((toolName) => toolName !== APPLY_PATCH_NAME);
}

function replaceEditToolsWithApplyPatch(toolNames: string[]): string[] {
	const hadApplyPatch = toolNames.includes(APPLY_PATCH_NAME);
	const insertIndex = toolNames.findIndex(
		(toolName) => EDIT_TOOL_NAMES.has(toolName) || toolName === APPLY_PATCH_NAME,
	);
	const filteredToolNames = withoutApplyPatch(toolNames).filter((toolName) => !EDIT_TOOL_NAMES.has(toolName));
	if (!hasEditTools(toolNames) && !hadApplyPatch) return filteredToolNames;
	const at = insertIndex === -1 ? filteredToolNames.length : Math.min(insertIndex, filteredToolNames.length);
	return [...filteredToolNames.slice(0, at), APPLY_PATCH_NAME, ...filteredToolNames.slice(at)];
}

function syncToolset(
	pi: ApplyPatchExtensionAPI,
	model: Model<string> | undefined,
	state: ApplyPatchToolsetState & { activeVariant?: ApplyPatchToolVariant },
	variants: Readonly<Record<ApplyPatchToolVariant, ReturnType<typeof createApplyPatchTool>>>,
): void {
	const mode = getApplyPatchWireMode(model);
	const currentToolNames = pi.getActiveTools();
	if (mode !== "none") {
		if (state.activeVariant !== mode) {
			pi.registerTool(variants[mode]);
			state.activeVariant = mode;
		}
		const activeEdit = currentToolNames.filter((toolName) => EDIT_TOOL_NAMES.has(toolName));
		if (activeEdit.length > 0) state.removedEditToolNames = activeEdit;
		pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
		return;
	}
	if (state.removedEditToolNames.length === 0) {
		if (currentToolNames.includes(APPLY_PATCH_NAME)) pi.setActiveTools(withoutApplyPatch(currentToolNames));
		return;
	}
	const registeredNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const restorable = state.removedEditToolNames.filter((toolName) => registeredNames.has(toolName));
	const restored = [...withoutApplyPatch(currentToolNames), ...restorable];
	state.removedEditToolNames = [];
	pi.setActiveTools([...new Set(restored)]);
}

export function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
	const state: ApplyPatchToolsetState & { activeVariant?: ApplyPatchToolVariant } = { removedEditToolNames: [] };
	const variants = {
		freeform: createApplyPatchTool("freeform"),
		json: createApplyPatchTool("json"),
	} as const;
	state.activeVariant = "freeform";
	pi.registerTool(variants.freeform);
	pi.on("session_start", async (_event, ctx) => {
		syncToolset(pi, ctx.model, state, variants);
	});
	pi.on("model_select", async (event) => {
		syncToolset(pi, event.model, state, variants);
	});
}

export default registerApplyPatchExtension;
