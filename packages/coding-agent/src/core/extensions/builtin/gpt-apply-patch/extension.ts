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
const EDIT_TOOL_NAMES = new Set(["edit", "write"]);
const APPLY_PATCH_NAME = "apply_patch";
const EDIT_TOOL_SWAP_ENTRY = "gpt-apply-patch:edit-tool-swap";

function isGptId(model: Pick<Model<string>, "api" | "id"> | undefined): model is Pick<Model<string>, "api" | "id"> {
	return model !== undefined && /(?:^|[/@:._-])gpt(?:[._-]|\d)/i.test(model.id);
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

function withoutApplyPatch(toolNames: string[]): string[] {
	return toolNames.filter((toolName) => toolName !== APPLY_PATCH_NAME);
}

function replaceEditToolsWithApplyPatch(toolNames: string[]): string[] {
	const insertIndex = toolNames.findIndex(
		(toolName) => EDIT_TOOL_NAMES.has(toolName) || toolName === APPLY_PATCH_NAME,
	);
	const filteredToolNames = withoutApplyPatch(toolNames).filter((toolName) => !EDIT_TOOL_NAMES.has(toolName));
	return [...filteredToolNames.slice(0, insertIndex), APPLY_PATCH_NAME, ...filteredToolNames.slice(insertIndex)];
}

function hasApplyPatchFailures(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	const result = Reflect.get(details, "result");
	if (typeof result !== "object" || result === null) return false;
	const failures = Reflect.get(result, "failures");
	return Array.isArray(failures) && failures.length > 0;
}

function syncToolset(
	pi: ApplyPatchExtensionAPI,
	model: Model<string> | undefined,
	state: ApplyPatchToolsetState & {
		activeVariant?: ApplyPatchToolVariant;
		wireMode: ApplyPatchWireMode;
	},
	variants: Readonly<Record<ApplyPatchToolVariant, ReturnType<typeof createApplyPatchTool>>>,
): void {
	const mode = getApplyPatchWireMode(model);
	state.wireMode = mode;
	const replaced = state.removedEditToolNames;
	if (mode !== "none") {
		if (state.activeVariant !== mode) {
			pi.registerTool(variants[mode]);
			state.activeVariant = mode;
		}
		const currentToolNames = pi.getActiveTools();
		const activeEdit = currentToolNames.filter((toolName) => EDIT_TOOL_NAMES.has(toolName));
		if (activeEdit.length === 0) return;
		if (!currentToolNames.includes(APPLY_PATCH_NAME)) {
			// Let the host apply its activation policy before removing any edit tools.
			pi.setActiveTools([...currentToolNames, APPLY_PATCH_NAME], { respectDefaultTools: true });
			if (!pi.getActiveTools().includes(APPLY_PATCH_NAME)) return;
		}
		pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
		const removed = [...new Set([...replaced, ...activeEdit])];
		if (removed.length > replaced.length) {
			state.removedEditToolNames = removed;
			pi.appendEntry(EDIT_TOOL_SWAP_ENTRY, removed, { startupBookkeeping: true });
		}
		return;
	}
	const currentToolNames = pi.getActiveTools();
	if (currentToolNames.includes(APPLY_PATCH_NAME)) {
		const registeredNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const restored = [
			...withoutApplyPatch(currentToolNames),
			...replaced.filter((name) => registeredNames.has(name)),
		];
		pi.setActiveTools([...new Set(restored)], { respectDefaultTools: true });
	}
	if (replaced.length > 0) {
		state.removedEditToolNames = [];
		pi.appendEntry(EDIT_TOOL_SWAP_ENTRY, [], { startupBookkeeping: true });
	}
}

function registerApplyPatchLazyActivator(
	pi: ApplyPatchExtensionAPI,
	state: { readonly wireMode: ApplyPatchWireMode },
): void {
	pi.registerLazyToolActivator?.((toolName) => {
		if (toolName !== APPLY_PATCH_NAME || state.wireMode === "none") return false;
		const activeToolNames = pi.getActiveTools();
		if (activeToolNames.includes(APPLY_PATCH_NAME)) return false;
		pi.setActiveTools([...activeToolNames, APPLY_PATCH_NAME], { respectDefaultTools: true });
		return pi.getActiveTools().includes(APPLY_PATCH_NAME);
	});
}

export function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
	const state: ApplyPatchToolsetState & {
		activeVariant?: ApplyPatchToolVariant;
		wireMode: ApplyPatchWireMode;
	} = { removedEditToolNames: [], wireMode: "none" };
	const variants = {
		freeform: createApplyPatchTool("freeform"),
		json: createApplyPatchTool("json"),
	} as const;
	state.activeVariant = "freeform";
	pi.registerTool(variants.freeform);
	registerApplyPatchLazyActivator(pi, state);
	pi.on("tool_result", async (event) => {
		if (event.toolName !== APPLY_PATCH_NAME || event.isError || !hasApplyPatchFailures(event.details)) {
			return undefined;
		}
		return { isError: true };
	});
	pi.on("session_start", async (_event, ctx) => {
		// The active list can survive a reload, but apply_patch can also be activated without a swap.
		const swap = ctx.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === EDIT_TOOL_SWAP_ENTRY);
		const names = swap?.type === "custom" ? swap.data : undefined;
		state.removedEditToolNames = Array.isArray(names)
			? names.filter((name): name is string => typeof name === "string" && EDIT_TOOL_NAMES.has(name))
			: [];
		syncToolset(pi, ctx.model, state, variants);
	});
	pi.on("model_select", async (event) => {
		syncToolset(pi, event.model, state, variants);
	});
}

export default registerApplyPatchExtension;
