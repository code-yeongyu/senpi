import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderContext } from "../../types.js";
import { defineTool } from "../../types.js";
import { applyPatchDetailed, buildPartialFailureText } from "./apply.js";
import { APPLY_PATCH_FREEFORM_DESCRIPTION, APPLY_PATCH_LARK_GRAMMAR, APPLY_PATCH_PARAMS } from "./constants.js";
import { normalizeApplyPatchArguments } from "./params.js";
import { createPendingPatchUpdate } from "./preview.js";
import { getApplyPatchRenderState, renderPatchPreview } from "./preview-format.js";
import { renderStreamingPatchCall } from "./streaming-render.js";
import type {
	ApplyPatchRenderState,
	ApplyPatchTheme,
	ApplyPatchToolDefinition,
	ApplyPatchToolDetails,
	FreeformToolFormat,
} from "./types.js";

function renderPreviewBox(
	title: string,
	details: ApplyPatchToolDetails,
	isPartial: boolean,
	cwd: string,
	expanded: boolean,
	theme: ApplyPatchTheme,
): Container {
	const component = new Container();
	if (!details.preview) return component;
	const bgName = isPartial ? "toolPendingBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(bgName, text));
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(renderPatchPreview(details.preview, cwd, theme, expanded), 0, 0));
	component.addChild(box);
	return component;
}

function renderTextResult(
	result: AgentToolResult<ApplyPatchToolDetails | undefined>,
	theme: ApplyPatchTheme,
): Container {
	const component = new Container();
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.filter((value) => typeof value === "string" && value.length > 0)
		.join("\n");
	if (text) component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
	return component;
}

export function createApplyPatchTool(): ApplyPatchToolDefinition {
	const tool = defineTool<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined, ApplyPatchRenderState>({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMS,
		prepareArguments: normalizeApplyPatchArguments,
		promptSnippet: "Apply Codex-format file patches with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
			"After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
		],
		async execute(
			_toolCallId,
			params,
			_signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<ApplyPatchToolDetails | undefined>> {
			const normalizedParams = normalizeApplyPatchArguments(params);
			if (!normalizedParams.input) throw new Error("input is required");
			const pendingUpdate = await createPendingPatchUpdate(ctx.cwd, normalizedParams.input);
			onUpdate?.({ content: [{ type: "text", text: pendingUpdate.text }], details: pendingUpdate.details });
			const result = await applyPatchDetailed(ctx.cwd, normalizedParams.input);
			if (result.failures.length > 0) {
				return { content: [{ type: "text", text: buildPartialFailureText(result) }], details: { result } };
			}
			return { content: [{ type: "text", text: result.summaries.join("\n") }], details: { result } };
		},
		renderCall(args, theme, context: ToolRenderContext<ApplyPatchRenderState, { input: string }>) {
			if (!context.argsComplete) return new Text(theme.fg("toolTitle", theme.bold("apply_patch: Patching")), 0, 0);
			if (!context.executionStarted) {
				const streaming = renderStreamingPatchCall(normalizeApplyPatchArguments(args), theme, context.state);
				if (streaming) return streaming;
			}
			const normalizedArgs = normalizeApplyPatchArguments(args);
			const renderState = getApplyPatchRenderState(context.toolCallId, context.cwd, normalizedArgs.input);
			const text = renderState.callText?.length ? `apply_patch: ${renderState.callText}` : "apply_patch";
			return new Text(theme.fg("toolTitle", theme.bold(text)), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (result.details?.preview) {
				const expanded = options.isPartial ? true : (options.expanded ?? true);
				return renderPreviewBox(
					options.isPartial ? "Applying patch" : "Applied patch",
					result.details,
					options.isPartial,
					context.cwd,
					expanded,
					theme,
				);
			}
			if (result.details?.result) {
				const component = new Container();
				const box = new Box(1, 1, (text: string) =>
					theme.bg(options.isPartial ? "toolPendingBg" : "toolSuccessBg", text),
				);
				box.addChild(new Text(theme.fg("toolTitle", theme.bold("Applying patch")), 0, 0));
				box.addChild(new Spacer(1));
				if (result.details.preview) {
					const expanded = options.isPartial ? true : (options.expanded ?? true);
					box.addChild(new Text(renderPatchPreview(result.details.preview, context.cwd, theme, expanded), 0, 0));
				}
				component.addChild(box);
				return component;
			}
			return renderTextResult(result, theme);
		},
	});

	return Object.assign(tool, {
		freeform: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_LARK_GRAMMAR } satisfies FreeformToolFormat,
	});
}
