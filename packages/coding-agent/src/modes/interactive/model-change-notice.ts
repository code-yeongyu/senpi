import type { ModelChangeOrigin, ModelChangeSource } from "../../core/model-change-origin.ts";
import type { ModelChangeEntry } from "../../core/session-manager.ts";

/** A durable transcript row for a model switch that landed during a streaming turn (senpi#2870). */
export interface ModelChangeNotice {
	readonly type: "model_change_notice";
	readonly text: string;
}

const DEFAULT_FLAG = "--default";

/** `/model <search> [--default]`: the flag asks for the selection to become the default for new sessions too. */
export function parseModelCommandArgument(argument: string | undefined): { searchTerm: string; asDefault: boolean } {
	const words = (argument ?? "")
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 0);
	const asDefault = words.includes(DEFAULT_FLAG);
	return { searchTerm: words.filter((word) => word !== DEFAULT_FLAG).join(" "), asDefault };
}

// Fallback switches already announce themselves with their own notice box.
function isAnnouncedElsewhere(source: ModelChangeSource): boolean {
	return source === "fallback" || source === "fallback-revert";
}

function describeOrigin(origin: ModelChangeOrigin): string {
	return origin.actor === undefined ? origin.source : `${origin.source}: ${origin.actor}`;
}

export function modelChangeNoticeText(input: {
	readonly from: string | undefined;
	readonly to: string;
	readonly origin: ModelChangeOrigin;
}): string {
	const route = input.from === undefined ? input.to : `${input.from} → ${input.to}`;
	return `⇄ Model changed mid-turn · ${route} (${describeOrigin(input.origin)})`;
}

export function liveModelChangeNotice(event: {
	readonly duringTurn: boolean;
	readonly origin: ModelChangeOrigin;
	readonly model: { readonly id: string };
	readonly previousModel?: { readonly id: string };
}): ModelChangeNotice | undefined {
	if (!event.duringTurn || isAnnouncedElsewhere(event.origin.source)) return undefined;
	return {
		type: "model_change_notice",
		text: modelChangeNoticeText({ from: event.previousModel?.id, to: event.model.id, origin: event.origin }),
	};
}

export function replayedModelChangeNotice(entry: ModelChangeEntry): ModelChangeNotice | undefined {
	if (entry.duringTurn !== true || entry.source === undefined || isAnnouncedElsewhere(entry.source)) return undefined;
	return {
		type: "model_change_notice",
		text: modelChangeNoticeText({
			from: entry.originalModelId,
			to: entry.modelId,
			origin: entry.actor === undefined ? { source: entry.source } : { source: entry.source, actor: entry.actor },
		}),
	};
}
