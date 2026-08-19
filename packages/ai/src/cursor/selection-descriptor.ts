import type { CursorAgentCompat, Model } from "../model.ts";
import type { ModelThinkingLevel, ThinkingSelection } from "../types.ts";
import {
	CURSOR_MODEL_CAPABILITIES,
	type CursorParameterId,
	getCursorVariantAlias,
	resolveCursorCatalogVariantId,
} from "./model-capabilities.ts";

export interface CursorResolvedSelection {
	readonly modelId: string;
	/** Bare capability id for the CLI `--model` bracket form. Native RPC uses `modelId`. */
	readonly cliModelId?: string;
	readonly parameters: readonly { readonly id: CursorParameterId; readonly value: string }[];
}

function identityCompat(model: Model<"cursor-agent">): CursorAgentCompat["cursorReasoning"] {
	return model.compat?.cursorReasoning;
}

function legacySuffixId(baseId: string, level: ModelThinkingLevel, value: string): string | undefined {
	const suffix = level === "off" ? "none" : value;
	const candidate = `${baseId}-${suffix}`;
	return getCursorVariantAlias(candidate)?.legacyVariantId;
}

function buildParameters(
	capabilityId: string,
	value: string,
	thinkingMode: boolean | undefined,
): { id: CursorParameterId; value: string }[] {
	const capability = CURSOR_MODEL_CAPABILITIES[capabilityId];
	if (!capability) return [];
	const out: { id: CursorParameterId; value: string }[] = [];
	for (const id of capability.parameterOrder) {
		switch (id) {
			case "thinking":
				out.push({ id, value: thinkingMode === true ? "true" : "false" });
				break;
			case "context": {
				const context = capability.requestContext ?? capability.defaultContext;
				if (context !== undefined) out.push({ id, value: context });
				break;
			}
			case "effort":
			case "reasoning":
				out.push({ id, value });
				break;
			case "fast":
				out.push({ id, value: "false" });
				break;
		}
	}
	return out;
}

/**
 * Resolve a Cursor model + thinking selection to its wire descriptor: the exact
 * native catalog variant id plus ordered parameters. The native lane sends
 * `modelId` on the protobuf Run RPC; the CLI lane renders `cliModelId ?? modelId`
 * as a `--model` string (bracket form still uses the bare capability id).
 * Absent/unsupported selections return the representative or upstream id with
 * zero parameters.
 */
export function resolveCursorSelectionDescriptor(
	model: Model<"cursor-agent">,
	selection: ThinkingSelection | undefined,
): CursorResolvedSelection {
	const compat = identityCompat(model);
	const fallback: CursorResolvedSelection = { modelId: model.upstreamModelId ?? model.id, parameters: [] };
	if (!compat) return fallback;

	if (selection === undefined) {
		return { modelId: compat.representativeVariantId, parameters: [] };
	}

	if (selection.source === "legacy-variant") {
		if (selection.legacyVariantId === undefined || getCursorVariantAlias(selection.legacyVariantId) === undefined) {
			return { modelId: compat.representativeVariantId, parameters: [] };
		}
		return { modelId: selection.legacyVariantId, parameters: [] };
	}

	const capability = CURSOR_MODEL_CAPABILITIES[compat.capabilityId];
	const spec = capability?.levels[selection.level];
	if (!capability || !spec) {
		return { modelId: compat.representativeVariantId, parameters: [] };
	}

	if (spec.encoding === "variant-id") {
		const suffixId = legacySuffixId(compat.capabilityId, selection.level, spec.value);
		if (suffixId === undefined) return { modelId: compat.representativeVariantId, parameters: [] };
		return { modelId: suffixId, parameters: [] };
	}

	return {
		modelId:
			resolveCursorCatalogVariantId(
				compat.capabilityId,
				spec.value,
				selection.level,
				compat.thinkingMode,
			) ?? compat.representativeVariantId,
		cliModelId: compat.capabilityId,
		parameters: buildParameters(compat.capabilityId, spec.value, compat.thinkingMode),
	};
}

/** Render the resolved descriptor as one CLI `--model` argv element (bracket or suffix form). */
export function renderCursorCliModelString(
	model: Model<"cursor-agent">,
	selection: ThinkingSelection | undefined,
): string {
	const resolved = resolveCursorSelectionDescriptor(model, selection);
	const modelId = resolved.cliModelId ?? resolved.modelId;
	if (resolved.parameters.length === 0) return modelId;
	const args = resolved.parameters.map((parameter) => `${parameter.id}=${parameter.value}`).join(",");
	return `${modelId}[${args}]`;
}
