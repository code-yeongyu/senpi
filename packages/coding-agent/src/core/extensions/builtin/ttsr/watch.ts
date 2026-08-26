import { resolveDetection } from "./coordinator.ts";
import { collapseDetector, createCollapseState } from "./detectors/collapse.ts";
import { corroboratesControlLeak, createControlLeakDetector } from "./detectors/control-leak.ts";
import type { TtsrManager } from "./manager.ts";
import { COLLAPSE_RULE_NAME, CONTROL_LEAK_RULE_NAME } from "./prompts.ts";
import type { DetectionResolution, DetectorContext, TtsrRule } from "./types.ts";

interface StreamTrack {
	readonly collapse: ReturnType<typeof createCollapseState>;
	readonly leak: ReturnType<ReturnType<typeof createControlLeakDetector>["createState"]>;
}

export interface WatchOutcome {
	readonly resolution: DetectionResolution | null;
	readonly ruleMatches: readonly TtsrRule[];
}

export class StreamWatcher {
	readonly #manager: TtsrManager;
	readonly #leakDetector = createControlLeakDetector();
	readonly #disabledBuiltin: ReadonlySet<string>;
	readonly #tracks = new Map<string, StreamTrack>();

	constructor(manager: TtsrManager, disabledBuiltinRules: readonly string[]) {
		this.#manager = manager;
		this.#disabledBuiltin = new Set(disabledBuiltinRules);
	}

	reset(): void {
		this.#tracks.clear();
		this.#manager.resetBuffers();
	}

	handleDelta(
		source: "text" | "thinking" | "tool",
		streamKey: string,
		delta: string,
		generation: number,
		toolName?: string,
	): WatchOutcome {
		const track = this.#trackFor(source, streamKey);
		const detectorCtx: DetectorContext = { source, streamKey, generation };
		const leakMatch = this.#disabledBuiltin.has(CONTROL_LEAK_RULE_NAME)
			? null
			: this.#leakDetector.checkDelta(track.leak, delta, detectorCtx);
		const collapseMatch = this.#disabledBuiltin.has(COLLAPSE_RULE_NAME)
			? null
			: collapseDetector.checkDelta(track.collapse, delta, detectorCtx);
		const evidence = track.leak.pendingEvidence;
		const corroborated =
			collapseMatch !== null &&
			evidence !== undefined &&
			corroboratesControlLeak(evidence, collapseMatch.anomalyStartOffset, track.leak.currentOffset)
				? collapseMatch
				: null;
		const resolution = resolveDetection(leakMatch, collapseMatch, corroborated);
		const ruleMatches = this.#manager.checkDelta(delta, { source, streamKey, toolName });
		return { resolution, ruleMatches };
	}

	#trackFor(source: "text" | "thinking" | "tool", streamKey: string): StreamTrack {
		const key = `${source}:${streamKey}`;
		let track = this.#tracks.get(key);
		if (track === undefined) {
			track = { collapse: createCollapseState(), leak: this.#leakDetector.createState() };
			this.#tracks.set(key, track);
		}
		return track;
	}
}
