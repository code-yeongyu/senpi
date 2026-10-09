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

	constructor(cooldowns: SelectorCooldowns) {
		this.cooldowns = cooldowns;
	}

	note(model: Model<Api>, failure: CircuitFailure): void {
		const scope = usageLimitScope(failure.errorMessage);
		if (scope === "account") this.cooldowns.note(accountKey(model.provider), failure);
		else if (scope === "model" || isHealthExhaustionFailure(failure.errorMessage)) {
			this.cooldowns.note(entryKey(model), failure);
		}
	}

	isProviderSpent(provider: string): boolean {
		return this.cooldowns.isSuppressed(accountKey(provider));
	}

	isUnusable(model: Model<Api>): boolean {
		return this.isProviderSpent(model.provider) || this.cooldowns.isSuppressed(entryKey(model));
	}

	clear(model: Model<Api>): void {
		this.cooldowns.clear(accountKey(model.provider));
		this.cooldowns.clear(entryKey(model));
	}
}

function accountKey(provider: string): string {
	return `account:${provider}`;
}

function entryKey(model: Model<Api>): string {
	return `exhausted:${formatSelector(model)}`;
}
