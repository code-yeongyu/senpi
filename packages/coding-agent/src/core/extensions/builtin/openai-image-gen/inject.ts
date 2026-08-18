import { GENERATE_IMAGE_TOOL_NAME } from "../imagegen/tool.ts";

/** Which image-generation surface owns the current request. */
export type ImageGenMode = "native" | "client" | "unavailable";

export const NATIVE_IMAGE_GEN_TOOL_TYPE = "image_generation";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNativeImageGenTool(tool: unknown): boolean {
	if (!isRecord(tool)) return false;
	const type = tool.type;
	return (
		typeof type === "string" &&
		(type === NATIVE_IMAGE_GEN_TOOL_TYPE || type.startsWith(`${NATIVE_IMAGE_GEN_TOOL_TYPE}_`))
	);
}

/**
 * Matches the client tool by name rather than by `type`: extension and faux
 * payloads describe function tools without a `type` discriminator.
 */
function isGenerateImageFunctionTool(tool: unknown): boolean {
	return isRecord(tool) && tool.name === GENERATE_IMAGE_TOOL_NAME;
}

/**
 * Enforces mutual exclusion between the client `generate_image` function tool
 * and the OpenAI Responses `image_generation` server tool at the wire level.
 *
 * Native entries are always removed first, so a payload that already carries one
 * (a replayed request, a second injector, a dated tool variant) can never end up
 * with duplicates and never leaks to a backend that does not implement it. When
 * nothing changes the ORIGINAL payload reference is returned, because payload
 * hooks chain and an unconditional copy would defeat identity checks downstream.
 */
export function applyImageGenerationTools(payload: unknown, mode: ImageGenMode): unknown {
	if (!isRecord(payload)) return payload;

	const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
	const stripFunctionTool = mode !== "client";
	const kept = (tools ?? []).filter(
		(tool: unknown) => !isNativeImageGenTool(tool) && !(stripFunctionTool && isGenerateImageFunctionTool(tool)),
	);
	const removed = (tools?.length ?? 0) !== kept.length;

	if (mode !== "native") {
		return removed ? { ...payload, tools: kept } : payload;
	}

	return { ...payload, tools: [...kept, { type: NATIVE_IMAGE_GEN_TOOL_TYPE }] };
}
