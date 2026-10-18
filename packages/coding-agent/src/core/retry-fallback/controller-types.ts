import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { FallbackCircuitAccess } from "./circuit.ts";
import type { SelectorCooldowns } from "./cooldown.ts";
import type { FallbackLogger } from "./log.ts";
import type { UsageLimitScope } from "./usage-limit.ts";

export interface ActiveFallbackState {
	chainKey: string;
	originalSelector: string;
	originalThinkingLevel?: ThinkingLevel;
	lastAppliedThinkingLevel?: ThinkingLevel;
	/** Pin provenance: refusal contributions release on compaction, billing never. */
	pinnedByRefusal: boolean;
	pinnedByBilling: boolean;
	/** Derived OR of the two provenance flags - the only field consumers read. */
	pinned: boolean;
}

export type FallbackReason = "transient" | "refusal" | "hard-error" | "billing";
/** Absent: the original recovered after its cooldown. `fallback-unusable`: the fallback itself could not serve. */
export type FallbackRevertCause = "fallback-unusable";
export type CircuitFailure = { errorMessage?: string; retryAfterMs?: number };

export interface FallbackSettings {
	modelFallback: boolean;
	chains: Readonly<Record<string, readonly string[]>>;
}

export interface RetryFallbackControllerDeps {
	getSettings(): FallbackSettings;
	registry: {
		find(provider: string, id: string): Model<Api> | undefined;
		getAll(): Model<Api>[];
		/** Ranks bare-selector expansion: OAuth-credential providers come first. */
		isUsingOAuth?(model: Model<Api>): boolean;
		/** Filters bare-selector expansion: a definitive `false` keeps a lane that can never serve out of the chain. */
		isFallbackEligible?(model: Model<Api>): boolean;
	};
	cooldowns: SelectorCooldowns;
	/** Chain-entry circuits shared with every session in the process on the same agent dir. */
	circuits?: FallbackCircuitAccess;
	logger: FallbackLogger;
	switchModel(model: Model<Api>, thinking: ThinkingLevel, reason: "fallback" | "fallback-revert"): Promise<void>;
	/** True when `switchModel` refused this candidate itself (e.g. its window cannot hold the session), so the next rung may still fit. */
	isCandidateRefusal?(error: unknown): boolean;
	emit(
		event:
			| {
					type: "retry_fallback_applied";
					from: string;
					to: string;
					chainKey: string;
					reason: FallbackReason;
					limit?: UsageLimitScope;
			  }
			| { type: "retry_fallback_reverted"; from: string; to: string; cause?: FallbackRevertCause },
	): void;
	getCurrentSelector(): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined;
	isAuthAvailable(provider: string): boolean;
}
