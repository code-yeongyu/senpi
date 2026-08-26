import type { CursorAgentCompat, Model } from "../model.ts";
import type { ModelThinkingLevel, ThinkingSelection } from "../types.ts";
import {
	CURSOR_MODEL_CAPABILITIES,
	type CursorLevelSpec,
	type CursorParameterId,
	getCursorVariantAlias,
} from "./model-capabilities.ts";

export interface CursorResolvedSelection {
	readonly modelId: string;
	readonly parameters: readonly { readonly id: CursorParameterId; readonly value: string }[];
}

function identityCompat(model: Model<"cursor-agent">): CursorAgentCompat["cursorReasoning"] {
	return model.compat?.cursorReasoning;
}

type CursorReasoningIdentity = NonNullable<CursorAgentCompat["cursorReasoning"]>;

/**
 * Catalog-guaranteed suffix alias for a base + level, or undefined. Cursor Run
 * rejects bare capability ids with Connect `not_found` (issue #1008; live
 * probes 2026-08-20), so every resolvable level prefers the suffix variant id
 * the `GetUsableModels` catalog actually serves. Candidates try the level's
 * wire value first, then the level token itself (`extra-high` vs `xhigh`),
 * with thinking-infixed forms for thinking Claude identities.
 */
function suffixAliasId(
	compat: CursorReasoningIdentity,
	level: ModelThinkingLevel,
	spec: CursorLevelSpec,
): string | undefined {
	const suffixes = level === "off" ? ["none"] : spec.value === level ? [spec.value] : [spec.value, level];
	for (const suffix of suffixes) {
		const candidates =
			compat.thinkingMode === true
				? [`${compat.capabilityId}-thinking-${suffix}`, `${compat.capabilityId}-${suffix}-thinking`]
				: [`${compat.capabilityId}-${suffix}`];
		for (const candidate of candidates) {
			const alias = getCursorVariantAlias(candidate);
			if (alias) return alias.legacyVariantId;
		}
	}
	return undefined;
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
 * model id plus ordered parameters. Both Cursor transports consume this; the
 * native lane renders parameters into protobuf, the CLI lane renders a model
 * string. Absent/unsupported selections return the representative or upstream
 * id with zero parameters.
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

	const suffixId = suffixAliasId(compat, selection.level, spec);
	if (suffixId !== undefined) return { modelId: suffixId, parameters: [] };

	if (spec.encoding === "variant-id") {
		return { modelId: compat.representativeVariantId, parameters: [] };
	}

	return {
		modelId: compat.capabilityId,
		parameters: buildParameters(compat.capabilityId, spec.value, compat.thinkingMode),
	};
}

/** Render the resolved descriptor as one CLI `--model` argv element (bracket or suffix form). */
export function renderCursorCliModelString(
	model: Model<"cursor-agent">,
	selection: ThinkingSelection | undefined,
): string {
	const resolved = resolveCursorSelectionDescriptor(model, selection);
	if (resolved.parameters.length === 0) return resolved.modelId;
	const args = resolved.parameters.map((parameter) => `${parameter.id}=${parameter.value}`).join(",");
	return `${resolved.modelId}[${args}]`;
}
