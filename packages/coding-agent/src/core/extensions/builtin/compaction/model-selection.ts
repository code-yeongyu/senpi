import type { ExtensionContext, ModelSelectEvent } from "../../types.ts";
import { resolveCompactionGeometry } from "./orchestration.ts";
import * as policy from "./policy.ts";
import type { SpeculativeCompactionSnapshot } from "./speculative.ts";
import type { CompactionExtensionState } from "./state.ts";

function matchesSelectedModel(snapshot: SpeculativeCompactionSnapshot | undefined, ctx: ExtensionContext): boolean {
	const jobModel = snapshot?.model;
	const selectedModel = ctx.model;
	return (
		jobModel !== undefined &&
		selectedModel !== undefined &&
		jobModel.api === selectedModel.api &&
		jobModel.provider === selectedModel.provider &&
		jobModel.id === selectedModel.id &&
		jobModel.baseUrl === selectedModel.baseUrl &&
		jobModel.contextWindow === selectedModel.contextWindow
	);
}

export function handleCompactionModelSelect(input: {
	event: ModelSelectEvent;
	ctx: ExtensionContext;
	state: CompactionExtensionState;
	speculativeSnapshot?: SpeculativeCompactionSnapshot;
	laneOwnsCompaction: boolean;
	breakerTripped: boolean;
	invalidate: () => void;
	start: () => void;
}): void {
	if (input.laneOwnsCompaction) {
		input.invalidate();
		return;
	}
	if (!matchesSelectedModel(input.speculativeSnapshot, input.ctx)) input.invalidate();
	const previousWindow = input.event.previousModel?.contextWindow ?? 0;
	const contextWindow = input.ctx.model?.contextWindow ?? 0;
	if (previousWindow <= contextWindow || input.breakerTripped) return;
	const usage = input.ctx.getContextUsage();
	if (!usage) return;
	const settings = input.ctx.getCompactionSettings();
	const { leadTokens } = resolveCompactionGeometry({
		contextWindow,
		settings,
		lastYield: input.state.lastYield ?? undefined,
	});
	if (
		policy.shouldStartSpeculativeCompaction(
			usage,
			contextWindow,
			settings,
			input.state.lastYield ?? undefined,
			leadTokens,
		)
	)
		input.start();
}
