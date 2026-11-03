import type { Api, Model } from "@earendil-works/pi-ai";
import { formatSelector } from "./chains.ts";
import { isHealthExhaustionFailure } from "./circuit-probes.ts";
import type { CircuitFailure } from "./controller-types.ts";
import type { SelectorCooldowns } from "./cooldown.ts";
import { rateLimitModelFamily } from "../credential-pool/model-scope.ts";
import { isBillingErrorMessage } from "./billing.ts";
import { usageLimitScope } from "./usage-limit.ts";

// A weekly window binds the account (seven_day) or one family (seven_day_opus/...); the text alone cannot tell.
const WEEKLY_LIMIT = /\bweekly\b[^.]*\blimit\b/i;
const MODEL_FAMILY = /(?:^|[^a-z])(opus|sonnet|haiku|fable|mythos)(?:[^a-z]|$)/i;

/** The model family a model id belongs to, when it names one. */
function modelFamilyOf(modelId: string): string | undefined {
	return MODEL_FAMILY.exec(modelId)?.[1]?.toLowerCase();
}

/** A once-per-provider check of a limit that named no family (senpi#5596). */
export type UsageLimitScopeProbe = {
	readonly provider: string;
	readonly heldFamily: string;
	readonly probeFamily: string;
	readonly outcome: "served" | "widened";
};

/**
 * Chain entries this session has seen refuse to serve for a reason retrying cannot
 * fix within the cooldown: an account-wide usage limit or billing failure (every
 * model on that provider is out) or a model-scoped limit/exhaustion (that entry is
 * out). Backed by the session's selector cooldowns under namespaced keys, so it is
 * runtime-only and expires on the same injected clock as every other suppression.
 */
export class UnusableEntries {
	private readonly cooldowns: SelectorCooldowns;
	private readonly accountErrors = new Map<string, string>();
	/** Providers whose limit named no family: the family it hit, awaiting one request on another family. */
	private readonly pendingProbes = new Map<string, string>();
	private readonly widenedFamilies = new Map<string, readonly string[]>();
	private readonly familyErrors = new Map<string, string>();

	constructor(cooldowns: SelectorCooldowns) {
		this.cooldowns = cooldowns;
	}

	note(model: Model<Api>, failure: CircuitFailure): UsageLimitScopeProbe | undefined {
		const scope = usageLimitScope(failure.errorMessage);
		const family = modelFamilyOf(model.id);
		// A subscription limit that names no family may bind only this family: hold it and let one request on
		// another family decide, instead of marking every model of the account spent (senpi#5596).
		if (
			scope === "account" &&
			family !== undefined &&
			failure.errorMessage !== undefined &&
			WEEKLY_LIMIT.test(failure.errorMessage) &&
			!isBillingErrorMessage(failure.errorMessage) &&
			rateLimitModelFamily(failure.errorMessage) === undefined
		) {
			const held = this.pendingProbes.get(model.provider);
			if (held === undefined || held === family) {
				this.pendingProbes.set(model.provider, family);
				this.cooldowns.note(familyKey(model.provider, family), failure);
				this.familyErrors.set(familyKey(model.provider, family), failure.errorMessage);
				return undefined;
			}
			this.pendingProbes.delete(model.provider);
			this.widenedFamilies.set(model.provider, [held, family]);
			this.cooldowns.note(accountKey(model.provider), failure);
			this.accountErrors.set(model.provider, failure.errorMessage);
			return { provider: model.provider, heldFamily: held, probeFamily: family, outcome: "widened" };
		}
		if (scope === "account") {
			this.cooldowns.note(accountKey(model.provider), failure);
			if (failure.errorMessage) this.accountErrors.set(model.provider, failure.errorMessage);
		} else if (scope === "model" || isHealthExhaustionFailure(failure.errorMessage)) {
			this.cooldowns.note(entryKey(model), failure);
		}
		return undefined;
	}

	/** A response served on `model`: a pending family probe on another family resolves as served. */
	noteServed(model: Pick<Model<Api>, "provider" | "id">): UsageLimitScopeProbe | undefined {
		const held = this.pendingProbes.get(model.provider);
		const family = modelFamilyOf(model.id);
		if (held === undefined || family === undefined || family === held) return undefined;
		this.pendingProbes.delete(model.provider);
		return { provider: model.provider, heldFamily: held, probeFamily: family, outcome: "served" };
	}

	/** The weekly-limit family hold on `model`, while it lasts (senpi#5596). */
	heldFamily(model: Model<Api>): { readonly family: string; readonly errorMessage: string } | undefined {
		const family = modelFamilyOf(model.id);
		if (family === undefined) return undefined;
		const key = familyKey(model.provider, family);
		const errorMessage = this.familyErrors.get(key);
		return errorMessage !== undefined && this.cooldowns.isSuppressed(key) ? { family, errorMessage } : undefined;
	}

	/** The two families a no-family limit was confirmed on before it widened to the account. */
	widenedFamiliesOf(provider: string): readonly string[] | undefined {
		return this.isProviderSpent(provider) ? this.widenedFamilies.get(provider) : undefined;
	}

	isProviderSpent(provider: string): boolean {
		return this.cooldowns.isSuppressed(accountKey(provider));
	}

	accountError(provider: string): string | undefined {
		return this.isProviderSpent(provider) ? this.accountErrors.get(provider) : undefined;
	}

	/** Wall-clock time the provider said its account limit resets; undefined when the hold is a guessed default. */
	accountResetAt(provider: string): number | undefined {
		return this.cooldowns.statedResetAt(accountKey(provider));
	}

	/**
	 * Drops an account hold whose length was a guessed default, so the next request asks the provider again
	 * (senpi#5568). A hold with a reset the provider stated is kept. Returns whether a hold was dropped.
	 */
	releaseGuessedAccountHold(provider: string): boolean {
		if (!this.isProviderSpent(provider) || this.accountResetAt(provider) !== undefined) return false;
		this.cooldowns.clear(accountKey(provider));
		this.accountErrors.delete(provider);
		return true;
	}

	isUnusable(model: Model<Api>): boolean {
		const family = modelFamilyOf(model.id);
		return (
			this.isProviderSpent(model.provider) ||
			this.cooldowns.isSuppressed(entryKey(model)) ||
			(family !== undefined && this.cooldowns.isSuppressed(familyKey(model.provider, family)))
		);
	}

	clear(model: Model<Api>): void {
		// A deliberate model selection allows the user to probe after reauth/reset.
		this.cooldowns.clear(entryKey(model));
		this.cooldowns.clear(accountKey(model.provider));
		this.accountErrors.delete(model.provider);
	}

	/** The provider's accounts changed (a login, an added or re-authorized account): every hold it earned is stale. */
	clearProvider(provider: string, models: readonly Model<Api>[]): void {
		this.cooldowns.clear(accountKey(provider));
		this.accountErrors.delete(provider);
		for (const model of models) {
			if (model.provider === provider) this.cooldowns.clear(entryKey(model));
		}
	}
}

function accountKey(provider: string): string {
	// This is a provider-name approximation, not resolved credential/account identity.
	// Gateways with distinct model accounts share a key; pooled slots can reset earlier
	// than the last surfaced account error. Explicit /model selection permits a probe.
	return `account:${provider}`;
}

function familyKey(provider: string, family: string): string {
	return `family:${provider}:${family}`;
}

function entryKey(model: Model<Api>): string {
	return `exhausted:${formatSelector(model)}`;
}
