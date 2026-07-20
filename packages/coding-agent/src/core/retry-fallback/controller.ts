import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "../thinking-levels.ts";
import {
	baseSelector,
	candidatesAfter,
	canonicalizeFallbackChains,
	type FallbackSelector,
	formatSelector,
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
	pinned: boolean;
}

type FallbackReason = "transient" | "refusal" | "hard-error";

interface FallbackSettings {
	modelFallback: boolean;
	chains: Readonly<Record<string, readonly string[]>>;
}

export interface RetryFallbackControllerDeps {
	getSettings(): FallbackSettings;
	registry: { find(provider: string, id: string): Model<Api> | undefined; getAll(): Model<Api>[] };
	cooldowns: SelectorCooldowns;
	logger: FallbackLogger;
	switchModel(model: Model<Api>, thinking: ThinkingLevel, reason: "fallback"): Promise<void>;
	emit(event: {
		type: "retry_fallback_applied";
		from: string;
		to: string;
		chainKey: string;
		reason: FallbackReason;
	}): void;
	getCurrentSelector(): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined;
	isAuthAvailable(provider: string): boolean;
}

export class RetryFallbackController {
	private readonly deps: RetryFallbackControllerDeps;
	private readonly triedSelectors = new Set<string>();
	private state: ActiveFallbackState | undefined;
	private lastExhaustedChainKey: string | undefined;

	constructor(deps: RetryFallbackControllerDeps) {
		this.deps = deps;
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
		this.resetTurn();
	}

	canTryFallback(): boolean {
		return this.nextCandidate(false) !== undefined;
	}

	async tryFallback(
		reason: FallbackReason,
		failure: { errorMessage?: string; retryAfterMs?: number },
	): Promise<boolean> {
		const current = this.deps.getCurrentSelector();
		const candidate = this.nextCandidate();
		if (!current || !candidate) return false;
		const currentBase = formatSelector(current.model);
		if (reason === "transient") {
			this.deps.cooldowns.note(currentBase, failure);
			this.deps.logger.info("cooldown_noted", { selector: currentBase, errorMessage: failure.errorMessage });
		}

		const thinking = this.selectThinking(candidate.selector, candidate.model, current.thinkingLevel);
		await this.deps.switchModel(candidate.model, thinking, "fallback");
		const from = formatSelector(current.model);
		const to = formatSelector(candidate.model);
		this.state = {
			chainKey: candidate.chainKey,
			originalSelector: this.state?.originalSelector ?? from,
			originalThinkingLevel: this.state?.originalThinkingLevel ?? current.thinkingLevel,
			lastAppliedThinkingLevel: thinking,
			pinned: this.state?.pinned === true || reason === "refusal",
		};
		this.deps.logger.info("fallback_applied", { from, to, chainKey: candidate.chainKey, reason });
		this.deps.emit({ type: "retry_fallback_applied", from, to, chainKey: candidate.chainKey, reason });
		return true;
	}

	private nextCandidate(reserve = true): { chainKey: string; selector: FallbackSelector; model: Model<Api> } | undefined {
		const settings = this.deps.getSettings();
		const current = this.deps.getCurrentSelector();
		if (!settings.modelFallback || !current) return undefined;
		const chains = canonicalizeFallbackChains(settings.chains, this.deps.registry);
		const chainKey = resolveChainKey(current.model, current.thinkingLevel, chains) ?? this.state?.chainKey;
		const entries = chainKey ? chains[chainKey] : undefined;
		if (!chainKey || !entries) return undefined;
		for (const raw of candidatesAfter(entries, formatSelector(current.model, current.thinkingLevel))) {
			const selector = parseFallbackSelector(raw, this.deps.registry);
			if (!selector) {
				this.skip(raw, "unknown");
				continue;
			}
			const base = baseSelector(selector);
			if (this.triedSelectors.has(base)) {
				this.skip(raw, "tried");
				continue;
			}
			if (this.deps.cooldowns.isSuppressed(base)) {
				this.skip(raw, "suppressed");
				continue;
			}
			if (!this.deps.isAuthAvailable(selector.provider)) {
				this.skip(raw, "unauthenticated");
				continue;
			}
			const model = this.deps.registry.find(selector.provider, selector.id);
			if (!model) {
				this.skip(raw, "unknown");
				continue;
			}
			if (reserve) this.triedSelectors.add(base);
			return { chainKey, selector, model };
		}
		this.lastExhaustedChainKey = chainKey;
		return undefined;
	}

	private selectThinking(
		selector: FallbackSelector,
		model: Model<Api>,
		inherited: ThinkingLevel | undefined,
	): ThinkingLevel {
		const requested = selector.thinkingLevel ?? inherited ?? "off";
		const supported = getSupportedThinkingLevels(model);
		return supported.includes(requested) ? requested : (supported[supported.length - 1] ?? "off");
	}

	private skip(candidate: string, skipReason: string): void {
		this.deps.logger.debug("candidate_skipped", { candidate, skipReason });
	}
}
