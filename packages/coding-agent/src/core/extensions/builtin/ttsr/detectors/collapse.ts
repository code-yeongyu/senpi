import { FixedRing, type ScalarEntry, ScalarScanner } from "../stream-utils.ts";
import type { DetectorContext, DetectorMatch, StreamDetector } from "../types.ts";
import { createLineCycleState, type LineCycleState, updateLineCycles } from "./collapse-lines.ts";
import {
	createParagraphRepeatState,
	type ParagraphRepeatState,
	updateParagraphRepeats,
} from "./collapse-paragraphs.ts";
import { createShortPeriodState, type ShortPeriodState, updateShortPeriods } from "./collapse-periods.ts";
import {
	createDominantRunState,
	createWhitespaceFloodState,
	type DominantRunState,
	updateDominantRun,
	updateWhitespaceFlood,
	type WhitespaceFloodState,
} from "./collapse-scalars.ts";

export const TAIL_RING_CAPACITY = 512;

export interface CollapseState {
	readonly scanner: ScalarScanner;
	readonly tailRing: FixedRing<ScalarEntry>;
	readonly run: DominantRunState;
	readonly whitespace: WhitespaceFloodState;
	readonly periods: ShortPeriodState;
	readonly lines: LineCycleState;
	readonly paragraphs: ParagraphRepeatState;
	latched: DetectorMatch | null;
}

export function createCollapseState(): CollapseState {
	return {
		scanner: new ScalarScanner(),
		tailRing: new FixedRing<ScalarEntry>(TAIL_RING_CAPACITY),
		run: createDominantRunState(),
		whitespace: createWhitespaceFloodState(),
		periods: createShortPeriodState(),
		lines: createLineCycleState(),
		paragraphs: createParagraphRepeatState(),
		latched: null,
	};
}

function checkDelta(state: CollapseState, delta: string, context: DetectorContext): DetectorMatch | null {
	if (state.latched !== null) return state.latched;
	const watchParagraphs = context.source !== "tool";
	for (const entry of state.scanner.push(delta)) {
		state.tailRing.push(entry);
		const match =
			updateDominantRun(state.run, entry) ??
			updateWhitespaceFlood(state.whitespace, entry) ??
			updateShortPeriods(state.periods, entry, state.tailRing) ??
			updateLineCycles(state.lines, entry) ??
			(watchParagraphs ? updateParagraphRepeats(state.paragraphs, entry) : null);
		if (match !== null) {
			state.latched = match;
			return match;
		}
	}
	return null;
}

export const collapseDetector: StreamDetector<CollapseState> = {
	createState: createCollapseState,
	checkDelta,
};
