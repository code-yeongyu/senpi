import type { Api, Model } from "@earendil-works/pi-ai";
import { formatSelector } from "./chains.ts";
import { isHealthExhaustionFailure } from "./circuit-probes.ts";
import type { CircuitFailure } from "./controller-types.ts";
import type { SelectorCooldowns } from "./cooldown.ts";
import { usageLimitScope } from "./usage-limit.ts";

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

	constructor(cooldowns: SelectorCooldowns) {
		this.cooldowns = cooldowns;
	}

	note(model: Model<Api>, failure: CircuitFailure): void {
		const scope = usageLimitScope(failure.errorMessage);
		if (scope === "account") {
			this.cooldowns.note(accountKey(model.provider), failure);
			if (failure.errorMessage) this.accountErrors.set(model.provider, failure.errorMessage);
		} else if (scope === "model" || isHealthExhaustionFailure(failure.errorMessage)) {
			this.cooldowns.note(entryKey(model), failure);
		}
	}

	isProviderSpent(provider: string): boolean {
		return this.cooldowns.isSuppressed(accountKey(provider));
	}

	accountError(provider: string): string | undefined {
		return this.isProviderSpent(provider) ? this.accountErrors.get(provider) : undefined;
	}

	isUnusable(model: Model<Api>): boolean {
		return this.isProviderSpent(model.provider) || this.cooldowns.isSuppressed(entryKey(model));
	}

	clear(model: Model<Api>): void {
		// A deliberate model selection allows the user to probe after reauth/reset.
		this.cooldowns.clear(entryKey(model));
		this.cooldowns.clear(accountKey(model.provider));
		this.accountErrors.delete(model.provider);
	}
}

function accountKey(provider: string): string {
	// This is a provider-name approximation, not resolved credential/account identity.
	// Gateways with distinct model accounts share a key; pooled slots can reset earlier
	// than the last surfaced account error. Explicit /model selection permits a probe.
	return `account:${provider}`;
}

function entryKey(model: Model<Api>): string {
	return `exhausted:${formatSelector(model)}`;
}
