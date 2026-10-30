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
	rungSelector,
} from "./chains.ts";
import { CircuitProbes } from "./circuit-probes.ts";
import type {
	ActiveFallbackState,
	CircuitFailure,
	FallbackReason,
	RetryFallbackControllerDeps,
} from "./controller-types.ts";
import { pinAfterSwitch } from "./pin.ts";
import { isPureNetworkTransient } from "./transient-network.ts";
import { UnusableEntries } from "./unusable.ts";
import { type UsageLimitScope, usageLimitScope } from "./usage-limit.ts";

export type { ActiveFallbackState, RetryFallbackControllerDeps } from "./controller-types.ts";

export class RetryFallbackController {
	private readonly deps: RetryFallbackControllerDeps;
	private readonly triedSelectors = new Set<string>();
	private state: ActiveFallbackState | undefined;
	private lastExhaustedChainKey: string | undefined;
	// A fallback forced by a network blip serves out its turn; only the next turn boundary reverts it.
	private heldForNetworkBlip = false;
	// The model a network blip just failed on: none of its rungs is tried in that walk (senpi#3344).
	private blipModel: string | undefined;
	// Entries this session itself saw fail out of a chain: only these (or an entry spent for everyone)
	// may move the session off its model at a turn boundary (senpi#3467).
	private readonly ownFailures = new Set<string>();
	// Conservatively skip the refused provider for this turn: this synchronous scan cannot resolve
	// asynchronously prepared request credentials, including per-model endpoints or keys (senpi#2491).
	private readonly refusedProviders = new Set<string>();
	private readonly unusable: UnusableEntries;
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
		this.unusable = new UnusableEntries(deps.cooldowns);
	}

	get activeState(): Readonly<ActiveFallbackState> | undefined {
		return this.state;
	}

	get exhaustedChainKey(): string | undefined {
		return this.lastExhaustedChainKey;
	}

	isProviderSpent(provider: string): boolean {
		return this.unusable.isProviderSpent(provider);
	}

	accountError(provider: string): string | undefined {
		return this.unusable.accountError(provider);
	}

	resetTurn(): void {
		this.triedSelectors.clear();
		this.refusedProviders.clear();
		this.lastExhaustedChainKey = undefined;
	}

	clear(): void {
		this.state = undefined;
		this.heldForNetworkBlip = false;
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

	/** `refusedProvider`: the provider whose request-level refusal is being decided, before the walk records it. */
	canTryFallback(refusedProvider?: string): boolean {
		return this.nextCandidate(false, false, refusedProvider) !== undefined;
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
	 * Revert to the chain's original model at a turn boundary. Fires for unpinned
	 * state under the cooldown-expiry policy once the original selector is no longer
	 * suppressed and is still usable; pinned state and the "never" policy hold the
	 * fallback model. One exception outranks both the cooldown and the policy: a
	 * fallback that is itself known unusable (billing or an account limit) while the
	 * original is not is never where the session rests (senpi#2376).
	 */
	async maybeRestorePrimary(
		revertPolicy: "cooldown-expiry" | "never",
		boundary: "turn" | "continuation" = "turn",
	): Promise<boolean> {
		const heldForNetworkBlip = this.heldForNetworkBlip && boundary === "continuation";
		if (boundary === "turn") this.heldForNetworkBlip = false;
		const state = this.state;
		const current = this.deps.getCurrentSelector();
		if (!state || state.pinned || !current) return false;
		const selector = parseFallbackSelector(state.originalSelector, this.deps.registry);
		if (!selector || !this.deps.isAuthAvailable(selector.provider)) return false;
		const model = this.deps.registry.find(selector.provider, selector.id);
		if (!model) return false;
		const stranded = this.unusable.isUnusable(current.model) && !this.unusable.isUnusable(model);
		if (!stranded && (heldForNetworkBlip || !this.originalRecovered(state, revertPolicy))) return false;
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
		const cause = stranded ? ({ cause: "fallback-unusable" } as const) : {};
		const trigger = stranded ? { trigger: "fallback-unusable" } : {};
		this.deps.logger.info("fallback_reverted", { from, to: state.originalSelector, ...trigger });
		this.deps.emit({ type: "retry_fallback_reverted", from, to: state.originalSelector, ...cause });
		return true;
	}

	private originalRecovered(state: ActiveFallbackState, revertPolicy: "cooldown-expiry" | "never"): boolean {
		if (revertPolicy !== "cooldown-expiry") return false;
		const originalSelector = state.originalSelector;
		// The original rung may be parked by its own hard error while the model as a whole is not.
		const original = parseFallbackSelector(originalSelector, this.deps.registry);
		if (
			original &&
			state.originalThinkingLevel !== undefined &&
			this.deps.cooldowns.isSuppressed(rungSelector({ ...original, thinkingLevel: state.originalThinkingLevel }))
		)
			return false;
		// An entry the breaker tracks recovers on the circuit's clock; the per-session
		// cooldown only governs entries the breaker never opened (hard errors, breaker off).
		const suppressed = this.probes.governs(originalSelector)
			? this.probes.isOpen(originalSelector)
			: this.deps.cooldowns.isSuppressed(originalSelector);
		return !suppressed && this.probes.admit(originalSelector) !== "open";
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
		this.heldForNetworkBlip = false;
		this.ownFailures.delete(formatSelector(model));
		this.deps.cooldowns.clearModel(formatSelector(model));
		this.unusable.clear(model);
		this.probes.release();
		this.deps.circuits?.close(formatSelector(model));
	}

	/** A response this session got from `selector` succeeded: the entry serves it again (senpi#3467). */
	noteServed(selector: string): void {
		this.ownFailures.delete(selector);
		this.probes.accept(selector);
	}

	/**
	 * Records a failure that makes the entry unusable for every session - billing
	 * or quota exhaustion, or a transient failure that spent its budget or failed a
	 * half-open probe - independent of whether a fallback candidate remains.
	 */
	noteHealthFailure(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined, failure: CircuitFailure): void {
		this.unusable.note(model, failure);
		if (!this.managedChainKey({ model, thinkingLevel })) return;
		// A pure network fault is the transport's, not the model's: it never opens the shared circuit (senpi#3306).
		if (isPureNetworkTransient(failure.errorMessage)) return;
		this.ownFailures.add(formatSelector(model));
		this.probes.noteFailure(formatSelector(model), failure);
	}

	/**
	 * Turn-boundary skip: when the current entry's circuit is open because this session
	 * saw it fail (and has not been served by it since), or because its account is spent
	 * for everyone, move to the next closed entry without spending a request on it. A
	 * sibling's bare failure or Retry-After never moves this session (senpi#3467). With no
	 * closed entry left the current one stays and probes, so the chain never refuses a
	 * turn; a half-open current entry is claimed for this session.
	 */
	async rerouteAroundOpenCircuit(): Promise<boolean> {
		const current = this.deps.getCurrentSelector();
		if (!this.deps.circuits || !current) return false;
		const currentBase = formatSelector(current.model);
		// A half-open entry is still claimed as this session's single probe whoever opened it.
		if (this.probes.admit(currentBase) !== "open") return false;
		// Another session's bare failure says this entry was slow for that session, not that it is
		// down for this one: a session that never failed on it keeps its model and finds out itself.
		if (!this.ownFailures.has(currentBase) && !this.probes.isExhausted(currentBase)) return false;
		const candidate = this.nextCandidate(false, true);
		if (!candidate || candidate.circuitOpen) return false;
		this.deps.logger.info("circuit_open_skip", { selector: currentBase });
		await this.applyCandidate(current, candidate, "transient");
		return true;
	}

	async tryFallback(
		reason: FallbackReason,
		failure: { errorMessage?: string; retryAfterMs?: number; refusedProvider?: string },
		failureObserved = true,
	): Promise<boolean> {
		if (failure.refusedProvider !== undefined) this.refusedProviders.add(failure.refusedProvider);
		const current = this.deps.getCurrentSelector();
		const blip = reason === "transient" && isPureNetworkTransient(failure.errorMessage);
		this.blipModel = blip && current ? formatSelector(current.model) : undefined;
		try {
			return await this.walkFallback(reason, failure, failureObserved);
		} finally {
			this.blipModel = undefined;
		}
	}

	private async walkFallback(
		reason: FallbackReason,
		failure: { errorMessage?: string; retryAfterMs?: number },
		failureObserved: boolean,
	): Promise<boolean> {
		const current = this.deps.getCurrentSelector();
		// A network blip that outlasted the same-model retries may fall back for this turn, but it
		// leaves no cooldown or open circuit on the primary, so the next turn boundary reverts (senpi#3306).
		const networkBlip = reason === "transient" && isPureNetworkTransient(failure.errorMessage);
		// Only a transient failure that spent its budget opens the shared circuit
		// here; billing/quota exhaustion is recorded at the failure itself (see
		// noteHealthFailure) so the final chain entry opens too.
		if (failureObserved && current && reason === "transient")
			this.noteHealthFailure(current.model, current.thinkingLevel, failure);
		const limit = usageLimitScope(failure.errorMessage);
		if (failureObserved && current) this.unusable.note(current.model, failure);
		// A model-wide park (transient, billing) can rule out the current model's other rungs, so the
		// walk re-scans after noting it; the first scan logs only when no re-scan follows.
		const modelWidePark = !networkBlip && failureObserved && (reason === "transient" || reason === "billing");
		let candidate = this.nextCandidate(false, !modelWidePark);
		if (!current || !candidate) {
			if (modelWidePark) this.nextCandidate(false, true);
			return false;
		}
		const currentBase = formatSelector(current.model);
		if (
			!networkBlip &&
			failureObserved &&
			(reason === "transient" || reason === "hard-error" || reason === "billing")
		) {
			// A hard error is charged to the rung that failed (a level the model rejects, or any
			// non-retryable failure there), so it parks only that rung and a
			// later rung of the same model stays reachable; a transient or billing failure parks the
			// whole model, which is unhealthy at every level (senpi#3311). A network blip parks
			// nothing (senpi#3306).
			const parked =
				reason === "hard-error"
					? rungSelector({
							provider: current.model.provider,
							id: current.model.id,
							thinkingLevel: current.thinkingLevel,
						})
					: currentBase;
			this.deps.cooldowns.note(parked, failure);
			this.deps.logger.info("cooldown_noted", { selector: parked, errorMessage: failure.errorMessage });
		}
		if (modelWidePark) candidate = this.nextCandidate(false, true);
		// A rung the switch itself refuses does not end the walk: the next rung may fit (senpi#2894).
		while (candidate) {
			try {
				await this.applyCandidate(current, candidate, reason, limit);
				this.heldForNetworkBlip ||= networkBlip;
				return true;
			} catch (error) {
				if (!this.deps.isCandidateRefusal?.(error)) throw error;
				this.triedSelectors.add(rungSelector(candidate.selector));
				this.skip(formatSelector(candidate.model), "refused");
			}
			candidate = this.nextCandidate(false, true);
		}
		return false;
	}

	private async applyCandidate(
		current: { model: Model<Api>; thinkingLevel?: ThinkingLevel },
		candidate: { chainKey: string } & UsableCandidate,
		reason: FallbackReason,
		limit?: UsageLimitScope,
	): Promise<void> {
		const thinking = this.selectThinking(candidate.selector, candidate.model, current.thinkingLevel);
		this.probes.admit(baseSelector(candidate.selector));
		await this.switchOrRelease(candidate.model, thinking, "fallback");
		this.triedSelectors.add(rungSelector(candidate.selector));
		const from = formatSelector(current.model);
		const to = formatSelector(candidate.model);
		const prior = this.state;
		this.state = {
			chainKey: candidate.chainKey,
			originalThinkingLevel: prior?.originalThinkingLevel ?? current.thinkingLevel,
			lastAppliedThinkingLevel: thinking,
			...pinAfterSwitch(prior, { from, fromProvider: current.model.provider, reason, limit }),
		};
		const scope = limit === undefined ? {} : { limit };
		this.deps.logger.info("fallback_applied", { from, to, chainKey: candidate.chainKey, reason, ...scope });
		this.deps.emit({ type: "retry_fallback_applied", from, to, chainKey: candidate.chainKey, reason, ...scope });
	}

	/** The chain governing `current`, when fallback is enabled; a model's own chain wins over an active one. */
	private managedChainKey(current: { model: Model<Api>; thinkingLevel?: ThinkingLevel }): string | undefined {
		if (!this.deps.getSettings().modelFallback) return undefined;
		const chains = this.canonicalChains();
		const chainKey = resolveChainKey(current.model, current.thinkingLevel, chains) ?? this.state?.chainKey;
		return chainKey && chains[chainKey] ? chainKey : undefined;
	}

	private nextCandidate(
		reserve = true,
		logDecision = reserve,
		refusedProvider?: string,
	): ({ chainKey: string } & UsableCandidate) | undefined {
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
			isProviderSpent: (provider) => this.unusable.isProviderSpent(provider),
			isProviderRefused: (provider) => provider === refusedProvider || this.refusedProviders.has(provider),
			isModelSkipped: (base) => base === this.blipModel,
			skip: (raw, skipReason) => this.skip(raw, skipReason),
		});
		if (candidate) {
			if (reserve) this.triedSelectors.add(rungSelector(candidate.selector));
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
