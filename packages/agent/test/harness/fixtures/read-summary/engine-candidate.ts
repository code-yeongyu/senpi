import { READ_FOLD_SETTINGS } from "../../../../src/harness/utils/read-folders/index.ts";
import type { ReadFolder } from "../../../../src/harness/utils/read-folders/types.ts";
import { createSegmentedReadView } from "../../../../src/harness/utils/segmented-read-view.ts";
import type { Prototype } from "./heuristic.ts";
import type { Fold } from "./scorer.ts";

export type EngineCandidate = Prototype & { readonly discoveredFolds: readonly Fold[] };

/** One fold-boundary engine measured under the shipped view, independent of the frozen selection. */
export function engineCandidate(folder: ReadFolder, path: string, source: string): EngineCandidate {
	const parsed = folder.fold({ path, text: source, settings: READ_FOLD_SETTINGS });
	const view = createSegmentedReadView({ text: source, parsed });
	const queue = parsed.status === "parsed" ? [...parsed.ranges] : [];
	for (let index = 0; index < queue.length; index++) queue.push(...queue[index].children);
	const discoveredFolds = queue.map((range) => ({ start: range.startLine, end: range.endLine }));
	if (view.status === "summary")
		return {
			discoveredFolds,
			text: view.rendered.text,
			folds: view.rendered.elidedRanges.map((range) => ({ start: range.startLine, end: range.endLine })),
			reason: "folded",
			scanned_folds: queue.length,
		};
	const reason = parsed.status === "parse_failure" ? parsed.reason : view.reason;
	return { discoveredFolds, text: source, folds: [], reason, fallback_reason: reason, scanned_folds: queue.length };
}
