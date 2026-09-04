import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ModelUsabilityBudgetProjection } from "../extensions/builtin/compaction/model-usability-budget.ts";
import {
	baseSelector,
	candidatesAfter,
	canonicalizeFallbackChains,
	type FallbackChains,
	type FallbackSelector,
	formatSelector,
	hasExplicitFallbackOptOut,
	parseFallbackSelector,
	resolveChainKey,
} from "./chains.ts";
import type { SelectorCooldowns } from "./cooldown.ts";
import type { FallbackLogger } from "./log.ts";

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

type FallbackReason = "transient" | "refusal" | "hard-error" | "billing";

/**
 * Why a chain rung never became the active model. Every reason here is a verdict
 * about the rung itself, so the walk may move on; a failure that is not one of
 * these is a defect and propagates instead of silently burning candidates.
 */
export type FallbackRejectionReason =
	| "unknown"
	| "self"
	| "tried"
	| "suppressed"
	| "unauthenticated"
	| "context-unusable";

export interface FallbackRejectedCandidate {
	readonly selector: string;
	readonly reason: FallbackRejectionReason;
	/** Budget arithmetic behind a `context-unusable` verdict, when it was available. */
	readonly projection?: ModelUsabilityBudgetProjection;
	/** Failure text when the verdict came from a rejected switch rather than the preflight. */
	readonly error?: string;
}

export type CandidateUsability =
	| { readonly usable: true }
	| { readonly usable: false; readonly projection?: ModelUsabilityBudgetProjection };

export type FallbackExhaustionReason = "candidates-exhausted" | "no-context-compatible-candidate";

export interface FallbackExhaustion {
	readonly chainKey: string;
	/** Selector that was active when the walk ran out of rungs. */
	readonly from: string;
	readonly reason: FallbackExhaustionReason;
	readonly rejectedCandidates: readonly FallbackRejectedCandidate[];
}

interface FallbackSettings {
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
	logger: FallbackLogger;
	/**
	 * Capacity preflight for one candidate against the live conversation. Only a
	 * definitive `false` removes the rung; omitting the probe entirely leaves the
	 * chain exactly as wide as it is without one. The probe must be total - a failure
	 * inside it propagates rather than being read as "candidate is fine".
	 */
	isCandidateUsable?(model: Model<Api>): CandidateUsability;
	/**
	 * Classifies a failure thrown by {@link switchModel}. A returned projection means
	 * the target was refused on capacity grounds after `model_select` ran, which the
	 * preflight cannot see; the walk then treats the rung as spent. Returning
	 * `undefined` means the failure is not a verdict about this candidate (an
	 * extension defect, an aborted switch), and the controller rethrows it rather
	 * than quietly consuming the rest of the chain.
	 */
	classifySwitchFailure?(error: unknown): { projection?: ModelUsabilityBudgetProjection } | undefined;
	switchModel(model: Model<Api>, thinking: ThinkingLevel, reason: "fallback" | "fallback-revert"): Promise<void>;
	emit(
		event:
			| {
					type: "retry_fallback_applied";
					from: string;
					to: string;
					chainKey: string;
					reason: FallbackReason;
			  }
			| { type: "retry_fallback_reverted"; from: string; to: string },
	): void;
	getCurrentSelector(): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined;
	isAuthAvailable(provider: string): boolean;
}

export class RetryFallbackController {
	private readonly deps: RetryFallbackControllerDeps;
	private readonly triedSelectors = new Set<string>();
	// Turn-scoped rejection ledger, keyed by selector so a rung re-walked on a later
	// error is recorded once. First write wins: the reason that first removed a rung
	// explains it better than the "tried" skip a subsequent walk would overwrite it with.
	private readonly rejectedCandidates = new Map<string, FallbackRejectedCandidate>();
	private state: ActiveFallbackState | undefined;
	private lastExhaustedChainKey: string | undefined;
	private lastExhaustion: FallbackExhaustion | undefined;
	// Content-keyed memo of canonicalizeFallbackChains. Provider-error handling calls
	// canTryFallback/nextCandidate several times per error; without this each call
	// re-expands bare selectors and re-probes registry eligibility over the full
	// model set. Keying on the serialized chains content means an unchanged config
	// reuses the canonical result, while a chains edit invalidates immediately.
	// Registry mutations without a chains change are not tracked here; they are rare
	// and in practice coincide with a settings reload that replaces the chains object.
	private canonicalCache: { key: string; chains: FallbackChains } | undefined;

	constructor(deps: RetryFallbackControllerDeps) {
		this.deps = deps;
	}

	get activeState(): Readonly<ActiveFallbackState> | undefined {
		return this.state;
	}

	get exhaustedChainKey(): string | undefined {
		return this.lastExhaustedChainKey;
	}

	/**
	 * Structured detail for the chain reported by {@link exhaustedChainKey}. Kept
	 * separate from that getter so the existing string-only consumers keep working
	 * and a caller that stubs one never silently reads stale detail from the other.
	 */
	get exhaustion(): FallbackExhaustion | undefined {
		return this.lastExhaustion;
	}

	resetTurn(): void {
		this.triedSelectors.clear();
		this.rejectedCandidates.clear();
		this.lastExhaustedChainKey = undefined;
		this.lastExhaustion = undefined;
	}

	clear(): void {
		this.state = undefined;
		this.canonicalCache = undefined;
		this.resetTurn();
	}

	private canonicalChains(): FallbackChains {
		const chains = this.deps.getSettings().chains;
		const key = JSON.stringify(chains);
		if (this.canonicalCache?.key === key) return this.canonicalCache.chains;
		const canonical = canonicalizeFallbackChains(chains, this.deps.registry);
		this.canonicalCache = { key, chains: canonical };
		return canonical;
	}

	canTryFallback(): boolean {
		return this.nextCandidate(false) !== undefined;
	}

	/**
	 * Whether a chain exists for the current model at all, regardless of whether
	 * a candidate is usable right now. `canTryFallback()` answers the latter and
	 * goes false on cooldown or exhaustion, so it cannot tell a UI "you never
	 * configured a chain" apart from "the chain is spent".
	 */
	hasConfiguredChain(): boolean {
		const current = this.deps.getCurrentSelector();
		if (!current) return false;
		const chains = this.canonicalChains();
		return resolveChainKey(current.model, current.thinkingLevel, chains) !== undefined;
	}

	/**
	 * Revert to the chain's original model at a turn boundary. Only fires for
	 * unpinned state under the cooldown-expiry policy once the original selector
	 * is no longer suppressed and is still usable; pinned (refusal) state and the
	 * "never" policy always hold the fallback model.
	 */
	async maybeRestorePrimary(revertPolicy: "cooldown-expiry" | "never"): Promise<boolean> {
		const state = this.state;
		if (!state || state.pinned || revertPolicy !== "cooldown-expiry") return false;
		if (this.deps.cooldowns.isSuppressed(state.originalSelector)) return false;
		const selector = parseFallbackSelector(state.originalSelector, this.deps.registry);
		if (!selector || !this.deps.isAuthAvailable(selector.provider)) return false;
		const model = this.deps.registry.find(selector.provider, selector.id);
		const current = this.deps.getCurrentSelector();
		if (!model || !current) return false;
		// User override wins: only restore the original thinking level when the
		// current level still equals the level the fallback switch applied. A manual
		// setThinkingLevel clears lastAppliedThinkingLevel (see noteManualThinkingLevel).
		const thinking =
			current.thinkingLevel === state.lastAppliedThinkingLevel
				? (state.originalThinkingLevel ?? current.thinkingLevel ?? "off")
				: (current.thinkingLevel ?? "off");
		await this.deps.switchModel(model, thinking, "fallback-revert");
		const from = formatSelector(current.model);
		this.state = undefined;
		this.deps.logger.info("fallback_reverted", { from, to: state.originalSelector });
		this.deps.emit({ type: "retry_fallback_reverted", from, to: state.originalSelector });
		return true;
	}

	/**
	 * A user-driven setThinkingLevel makes the current level a deliberate choice,
	 * so the revert restore-rule must no longer treat it as fallback-applied.
	 */
	noteManualThinkingLevel(): void {
		if (this.state) this.state.lastAppliedThinkingLevel = undefined;
	}

	/**
	 * A senpi-owned compaction successfully rewrote the conversation context, the
	 * one safe moment to re-attempt a refusal-pinned fallback's original model:
	 * the refusal assumption ("the same context refuses again") no longer holds.
	 * Refusal contributions clear; billing contributions never release - retrying
	 * the same account never recovers it. Returns true only when the overall pin
	 * transitioned true -> false, i.e. the caller may now restore the primary via
	 * the existing maybeRestorePrimary gate.
	 */
	notifyCompactionApplied(): boolean {
		const state = this.state;
		if (!state) return false;
		state.pinnedByRefusal = false;
		const wasPinned = state.pinned;
		state.pinned = state.pinnedByBilling;
		if (!wasPinned || state.pinned) return false;
		this.deps.logger.info("refusal_pin_released", {
			chainKey: state.chainKey,
			originalSelector: state.originalSelector,
			trigger: "compaction",
		});
		return true;
	}

	/** A user-driven model change abandons the fallback window entirely. */
	clearForManualModelChange(model: Model<Api>): void {
		if (this.state) {
			this.deps.logger.info("fallback_cleared_manual", { selector: formatSelector(model) });
		}
		this.state = undefined;
		this.deps.cooldowns.clear(formatSelector(model));
	}

	async tryFallback(
		reason: FallbackReason,
		failure: { errorMessage?: string; retryAfterMs?: number },
	): Promise<boolean> {
		const current = this.deps.getCurrentSelector();
		if (!current) return false;
		let candidate = this.nextCandidate();
		if (!candidate) return false;
		const currentBase = formatSelector(current.model);
		if (reason === "transient" || reason === "hard-error" || reason === "billing") {
			this.deps.cooldowns.note(currentBase, failure);
			this.deps.logger.info("cooldown_noted", { selector: currentBase, errorMessage: failure.errorMessage });
		}

		// Applying a model can fail after the point where a capacity preflight can see
		// it: a `model_select` handler may grow the system prompt or toolset past the
		// target's budget. The switch owner restores itself before rethrowing, so the
		// walk simply moves to the next rung. Termination is guaranteed - every visited
		// rung is added to `triedSelectors`, which `nextCandidate` skips.
		while (candidate) {
			const thinking = this.selectThinking(candidate.selector, candidate.model, current.thinkingLevel);
			try {
				await this.deps.switchModel(candidate.model, thinking, "fallback");
			} catch (error) {
				const rejection = this.deps.classifySwitchFailure?.(error);
				// Not a capacity verdict about this rung: surface it. Swallowing arbitrary
				// failures here would spend the whole chain on one broken extension.
				if (!rejection) throw error;
				const selector = baseSelector(candidate.selector);
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.recordRejection({
					selector,
					reason: "context-unusable",
					...(rejection.projection === undefined ? {} : { projection: rejection.projection }),
					error: errorMessage,
				});
				this.deps.logger.warn("fallback_switch_rejected", { candidate: selector, errorMessage });
				candidate = this.nextCandidate();
				continue;
			}
			const from = formatSelector(current.model);
			const to = formatSelector(candidate.model);
			const prior = this.state;
			const pinnedByRefusal = prior?.pinnedByRefusal === true || reason === "refusal";
			const pinnedByBilling = prior?.pinnedByBilling === true || reason === "billing";
			this.state = {
				chainKey: candidate.chainKey,
				originalSelector: prior?.originalSelector ?? from,
				originalThinkingLevel: prior?.originalThinkingLevel ?? current.thinkingLevel,
				lastAppliedThinkingLevel: thinking,
				pinnedByRefusal,
				pinnedByBilling,
				pinned: pinnedByRefusal || pinnedByBilling,
			};
			this.deps.logger.info("fallback_applied", { from, to, chainKey: candidate.chainKey, reason });
			this.deps.emit({ type: "retry_fallback_applied", from, to, chainKey: candidate.chainKey, reason });
			return true;
		}
		return false;
	}

	private nextCandidate(
		reserve = true,
	): { chainKey: string; selector: FallbackSelector; model: Model<Api> } | undefined {
		const settings = this.deps.getSettings();
		const current = this.deps.getCurrentSelector();
		if (!settings.modelFallback || !current) return undefined;
		const chains = this.canonicalChains();
		// Order matters: a model's own chain wins, then the active episode keeps
		// owning its walk (its last rung usually has no key of its own), and only
		// a session with neither falls back to the wildcard lane.
		const chainKey =
			resolveChainKey(current.model, current.thinkingLevel, chains) ??
			this.state?.chainKey ??
			(hasExplicitFallbackOptOut(settings.chains, current.model, current.thinkingLevel)
				? undefined
				: resolveChainKey(current.model, current.thinkingLevel, chains, { allowWildcard: true }));
		const entries = chainKey ? chains[chainKey] : undefined;
		if (!chainKey || !entries) {
			if (reserve) this.deps.logger.debug("no_chain", { selector: formatSelector(current.model) });
			return undefined;
		}
		for (const raw of candidatesAfter(entries, formatSelector(current.model, current.thinkingLevel))) {
			const selector = parseFallbackSelector(raw, this.deps.registry);
			if (!selector) {
				this.skip(raw, raw, "unknown", reserve);
				continue;
			}
			if (selector.provider === current.model.provider && selector.id === current.model.id) {
				this.skip(raw, baseSelector(selector), "self", reserve);
				continue;
			}
			const base = baseSelector(selector);
			if (this.triedSelectors.has(base)) {
				this.skip(raw, base, "tried", reserve);
				continue;
			}
			if (this.deps.cooldowns.isSuppressed(base)) {
				this.skip(raw, base, "suppressed", reserve);
				continue;
			}
			if (!this.deps.isAuthAvailable(selector.provider)) {
				this.skip(raw, base, "unauthenticated", reserve);
				continue;
			}
			const model = this.deps.registry.find(selector.provider, selector.id);
			if (!model) {
				this.skip(raw, base, "unknown", reserve);
				continue;
			}
			// Capacity preflight: a rung whose window cannot hold the live conversation
			// would only trade one dead lane for another, so keep walking the chain.
			const usability = this.assessUsability(model);
			if (usability && !usability.usable) {
				this.skip(raw, base, "context-unusable", reserve, { projection: usability.projection });
				continue;
			}
			if (reserve) this.triedSelectors.add(base);
			return { chainKey, selector, model };
		}
		this.lastExhaustedChainKey = chainKey;
		const rejectedCandidates = [...this.rejectedCandidates.values()];
		this.lastExhaustion = {
			chainKey,
			from: formatSelector(current.model),
			reason: rejectedCandidates.some((rejected) => rejected.reason === "context-unusable")
				? "no-context-compatible-candidate"
				: "candidates-exhausted",
			rejectedCandidates,
		};
		if (reserve) this.deps.logger.info("candidates_exhausted", { chainKey, reason: this.lastExhaustion.reason });
		return undefined;
	}

	/**
	 * Normalizes the injected probe's verdict. The probe is total: only its absence is
	 * handled here, and a failure inside it propagates, because a projection that
	 * cannot be computed is a defect rather than a verdict about this candidate.
	 */
	private assessUsability(model: Model<Api>): CandidateUsability | undefined {
		if (!this.deps.isCandidateUsable) return undefined;
		return this.deps.isCandidateUsable(model);
	}

	private recordRejection(rejected: FallbackRejectedCandidate): void {
		if (this.rejectedCandidates.has(rejected.selector)) return;
		this.rejectedCandidates.set(rejected.selector, rejected);
	}

	private selectThinking(
		selector: FallbackSelector,
		model: Model<Api>,
		inherited: ThinkingLevel | undefined,
	): ThinkingLevel {
		const requested = selector.thinkingLevel ?? inherited ?? "off";
		// Canonical clamp walks to the NEAREST supported level. Picking the highest
		// supported level instead would escalate an "off" request to max reasoning on
		// always-on fallback models.
		return clampThinkingLevel(model, requested);
	}

	/**
	 * Single funnel for every reason a rung is passed over. Context incompatibility
	 * is retained during admission probes so the session can route the otherwise
	 * terminal error through the extension-visible exhaustion path. Other reasons
	 * only enter the ledger during the reserving walk.
	 */
	private skip(
		candidate: string,
		selector: string,
		skipReason: FallbackRejectionReason,
		reserve: boolean,
		detail?: { projection?: ModelUsabilityBudgetProjection },
	): void {
		this.deps.logger.debug("candidate_skipped", { candidate, skipReason });
		if (!reserve && skipReason !== "context-unusable") return;
		this.recordRejection(
			detail?.projection === undefined
				? { selector, reason: skipReason }
				: { selector, reason: skipReason, projection: detail.projection },
		);
	}
}
