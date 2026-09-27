import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { firstUsableCandidate, type UsableCandidate } from "./candidates.ts";
import {
	baseSelector,
	canonicalizeFallbackChains,
	type FallbackChains,
	type FallbackSelector,
	formatSelector,
	parseFallbackSelector,
	resolveChainKey,
} from "./chains.ts";
import { CircuitProbes } from "./circuit-probes.ts";
import type {
	ActiveFallbackState,
	CircuitFailure,
	FallbackReason,
	RetryFallbackControllerDeps,
} from "./controller-types.ts";

export type { ActiveFallbackState, RetryFallbackControllerDeps } from "./controller-types.ts";

export class RetryFallbackController {
	private readonly deps: RetryFallbackControllerDeps;
	private readonly triedSelectors = new Set<string>();
	private state: ActiveFallbackState | undefined;
	private lastExhaustedChainKey: string | undefined;
	readonly probes: CircuitProbes;
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
		this.probes = new CircuitProbes(deps.circuits);
	}

	get activeState(): Readonly<ActiveFallbackState> | undefined {
		return this.state;
	}

	get exhaustedChainKey(): string | undefined {
		return this.lastExhaustedChainKey;
	}

	resetTurn(): void {
		this.triedSelectors.clear();
		this.lastExhaustedChainKey = undefined;
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
		// An entry the breaker tracks recovers on the circuit's clock; the per-session
		// cooldown only governs entries the breaker never opened (hard errors, breaker off).
		const suppressed = this.probes.governs(state.originalSelector)
			? this.probes.isOpen(state.originalSelector)
			: this.deps.cooldowns.isSuppressed(state.originalSelector);
		if (suppressed) return false;
		const selector = parseFallbackSelector(state.originalSelector, this.deps.registry);
		if (!selector || !this.deps.isAuthAvailable(selector.provider)) return false;
		const model = this.deps.registry.find(selector.provider, selector.id);
		const current = this.deps.getCurrentSelector();
		if (!model || !current) return false;
		if (this.probes.admit(state.originalSelector) === "open") return false;
		// User override wins: only restore the original thinking level when the
		// current level still equals the level the fallback switch applied. A manual
		// setThinkingLevel clears lastAppliedThinkingLevel (see noteManualThinkingLevel).
		const thinking =
			current.thinkingLevel === state.lastAppliedThinkingLevel
				? (state.originalThinkingLevel ?? current.thinkingLevel ?? "off")
				: (current.thinkingLevel ?? "off");
		await this.switchOrRelease(model, thinking, "fallback-revert");
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
		this.probes.release();
		this.deps.circuits?.close(formatSelector(model));
	}

	/**
	 * Records a failure that makes the entry unusable for every session - billing
	 * or quota exhaustion, or a transient failure that spent its budget or failed a
	 * half-open probe - independent of whether a fallback candidate remains.
	 */
	noteHealthFailure(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined, failure: CircuitFailure): void {
		if (!this.managedChainKey({ model, thinkingLevel })) return;
		this.probes.noteFailure(formatSelector(model), failure);
	}

	/**
	 * Turn-boundary skip: when the current entry's circuit was opened by this or a
	 * sibling session, move to the next closed entry without spending a request on
	 * it. With no closed entry left the current one stays and probes, so the chain
	 * never refuses a turn; a half-open current entry is claimed for this session.
	 */
	async rerouteAroundOpenCircuit(): Promise<boolean> {
		const current = this.deps.getCurrentSelector();
		if (!this.deps.circuits || !current) return false;
		const currentBase = formatSelector(current.model);
		if (this.probes.admit(currentBase) !== "open") return false;
		const candidate = this.nextCandidate(false, true);
		if (!candidate || candidate.circuitOpen) return false;
		this.deps.logger.info("circuit_open_skip", { selector: currentBase });
		await this.applyCandidate(current, candidate, "transient");
		return true;
	}

	async tryFallback(
		reason: FallbackReason,
		failure: { errorMessage?: string; retryAfterMs?: number },
	): Promise<boolean> {
		const current = this.deps.getCurrentSelector();
		// Only a transient failure that spent its budget opens the shared circuit
		// here; billing/quota exhaustion is recorded at the failure itself (see
		// noteHealthFailure) so the final chain entry opens too.
		if (current && reason === "transient") this.noteHealthFailure(current.model, current.thinkingLevel, failure);
		const candidate = this.nextCandidate(false, true);
		if (!current || !candidate) return false;
		const currentBase = formatSelector(current.model);
		if (reason === "transient" || reason === "hard-error" || reason === "billing") {
			this.deps.cooldowns.note(currentBase, failure);
			this.deps.logger.info("cooldown_noted", { selector: currentBase, errorMessage: failure.errorMessage });
		}
		await this.applyCandidate(current, candidate, reason);
		return true;
	}

	private async applyCandidate(
		current: { model: Model<Api>; thinkingLevel?: ThinkingLevel },
		candidate: { chainKey: string } & UsableCandidate,
		reason: FallbackReason,
	): Promise<void> {
		const thinking = this.selectThinking(candidate.selector, candidate.model, current.thinkingLevel);
		this.probes.admit(baseSelector(candidate.selector));
		await this.switchOrRelease(candidate.model, thinking, "fallback");
		this.triedSelectors.add(baseSelector(candidate.selector));
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
	}

	/** The chain governing `current`, when fallback is enabled; a model's own chain wins over an active one. */
	private managedChainKey(current: { model: Model<Api>; thinkingLevel?: ThinkingLevel }): string | undefined {
		if (!this.deps.getSettings().modelFallback) return undefined;
		const chains = this.canonicalChains();
		const chainKey = resolveChainKey(current.model, current.thinkingLevel, chains) ?? this.state?.chainKey;
		return chainKey && chains[chainKey] ? chainKey : undefined;
	}

	private nextCandidate(reserve = true, logDecision = reserve): ({ chainKey: string } & UsableCandidate) | undefined {
		const current = this.deps.getCurrentSelector();
		if (!this.deps.getSettings().modelFallback || !current) return undefined;
		// Models without an explicitly configured chain do not enter an implicit fallback lane.
		const chainKey = this.managedChainKey(current);
		const entries = chainKey ? this.canonicalChains()[chainKey] : undefined;
		if (!chainKey || !entries) {
			if (logDecision) this.deps.logger.debug("no_chain", { selector: formatSelector(current.model) });
			return undefined;
		}
		const candidate = firstUsableCandidate(entries, current, {
			registry: this.deps.registry,
			tried: this.triedSelectors,
			isSuppressed: (base) => this.deps.cooldowns.isSuppressed(base),
			isAuthAvailable: (provider) => this.deps.isAuthAvailable(provider),
			isCircuitOpen: (base) => this.deps.circuits?.isOpen(base) ?? false,
			skip: (raw, skipReason) => this.skip(raw, skipReason),
		});
		if (candidate) {
			if (reserve) this.triedSelectors.add(baseSelector(candidate.selector));
			return { chainKey, ...candidate };
		}
		this.lastExhaustedChainKey = chainKey;
		if (logDecision) this.deps.logger.info("candidates_exhausted", { chainKey });
		return undefined;
	}

	private async switchOrRelease(
		model: Model<Api>,
		thinking: ThinkingLevel,
		reason: "fallback" | "fallback-revert",
	): Promise<void> {
		try {
			await this.deps.switchModel(model, thinking, reason);
		} catch (error) {
			this.probes.release();
			throw error;
		}
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

	private skip(candidate: string, skipReason: string): void {
		this.deps.logger.debug("candidate_skipped", { candidate, skipReason });
	}
}
