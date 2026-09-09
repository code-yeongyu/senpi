import { create } from "@bufbuild/protobuf";
import { resolveCursorSelectionDescriptor } from "../../cursor/selection-descriptor.ts";
import type { Model } from "../../model.ts";
import type { ThinkingSelection } from "../../types.ts";
import { RequestedModel_ModelParameterbytesSchema, RequestedModelSchema } from "./gen/agent_pb.ts";

/**
 * Render the resolved Cursor selection into the protobuf `RequestedModel`
 * fields: resolved wire id, maxMode, and ordered parameters. An absent
 * selection yields the pre-grouping request shape (upstream id, no
 * parameters) byte-for-byte.
 */
export function buildRequestedModelFields(
	model: Model<"cursor-agent">,
	selection: ThinkingSelection | undefined,
): { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] } {
	const resolved = resolveCursorSelectionDescriptor(model, selection);
	return {
		modelId: resolved.modelId,
		maxMode: model.compat?.cursorMaxMode === true,
		parameters: resolved.parameters.map((parameter) => ({ id: parameter.id, value: parameter.value })),
	};
}

export function buildRequestedModel(
	model: Model<"cursor-agent">,
	selection: ThinkingSelection | undefined,
): ReturnType<typeof create<typeof RequestedModelSchema>> {
	const fields = buildRequestedModelFields(model, selection);
	return create(RequestedModelSchema, {
		modelId: fields.modelId,
		maxMode: fields.maxMode,
		parameters: fields.parameters.map((parameter) =>
			create(RequestedModel_ModelParameterbytesSchema, { id: parameter.id, value: parameter.value }),
		),
	});
}
