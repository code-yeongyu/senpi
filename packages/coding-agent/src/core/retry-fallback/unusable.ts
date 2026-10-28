import type { Api, Model } from "@earendil-works/pi-ai";
import type { CandidateRegistry } from "./candidates.ts";
import { isHealthExhaustionFailure } from "./circuit-probes.ts";
import type { CircuitFailure } from "./controller-types.ts";
import type { SelectorCooldowns } from "./cooldown.ts";
import { failureUpstream, modelUpstream } from "./upstream.ts";
import { type UsageLimitScope, usageLimitScope } from "./usage-limit.ts";

type ModelRef = Pick<Model<Api>, "provider" | "id">;

/**
 * Chain entries this session has seen refuse to serve for a reason retrying cannot
 * fix within the cooldown: an account-wide usage limit or billing failure (every
 * model on that provider is out) or a model-scoped limit/exhaustion (that entry is
 * out). Backed by the session's selector cooldowns under namespaced keys, so it is
 * runtime-only and expires on the same injected clock as every other suppression.
 *
 * An account-scoped failure that names an upstream vendor, on a provider whose
 * models come from several vendors (a gateway), holds only that provider's models
 * of that vendor (senpi#4577). A response the provider serves is proof against the
 * holds it contradicts, so it clears them (`noteServed`).
 */
export class UnusableEntries {
	private readonly cooldowns: SelectorCooldowns;
	private readonly registry: CandidateRegistry;
	// The failure text behind each hold key, for the advice shown when it refuses a request.
	private readonly holdErrors = new Map<string, string>();

	constructor(cooldowns: SelectorCooldowns, registry: CandidateRegistry) {
		this.cooldowns = cooldowns;
		this.registry = registry;
	}

	/**
	 * Who `failure` binds on `model`: `model` for a model-scoped limit and for an
	 * upstream hold on a gateway (its other upstreams still serve), `account` for a
	 * provider-wide hold, undefined when it is no usage limit.
	 */
	scope(model: ModelRef, errorMessage: string | undefined): UsageLimitScope | undefined {
		const scope = usageLimitScope(errorMessage);
		return scope === "account" && this.upstreamOf(model, errorMessage) !== undefined ? "model" : scope;
	}

	note(model: Model<Api>, failure: CircuitFailure): void {
		const scope = usageLimitScope(failure.errorMessage);
		if (scope === "account") {
			const upstream = this.upstreamOf(model, failure.errorMessage);
			const key = upstream === undefined ? accountKey(model.provider) : upstreamKey(model.provider, upstream);
			this.cooldowns.note(key, failure);
			if (failure.errorMessage) this.holdErrors.set(key, failure.errorMessage);
		} else if (scope === "model" || isHealthExhaustionFailure(failure.errorMessage)) {
			this.cooldowns.note(entryKey(model), failure);
		}
	}

	/** The provider's whole account is held: none of its models serve. */
	isProviderSpent(provider: string): boolean {
		return this.cooldowns.isSuppressed(accountKey(provider));
	}

	/** The account or the upstream serving `model` is held. */
	isSpent(model: ModelRef): boolean {
		return this.heldKey(model) !== undefined;
	}

	/** The failure text of the hold that rules `model` out, if one does. */
	spentError(model: ModelRef): string | undefined {
		const key = this.heldKey(model);
		return key === undefined ? undefined : this.holdErrors.get(key);
	}

	isUnusable(model: Model<Api>): boolean {
		return this.isSpent(model) || this.cooldowns.isSuppressed(entryKey(model));
	}

	/**
	 * `model` just served this session, which disproves its account hold, its
	 * upstream's hold and its own exhaustion mark. Holds on other providers and on
	 * the provider's other upstreams or models stay.
	 */
	noteServed(model: ModelRef): void {
		this.release(model);
	}

	clear(model: Model<Api>): void {
		// A deliberate model selection allows the user to probe after reauth/reset.
		this.release(model);
	}

	private release(model: ModelRef): void {
		const upstream = modelUpstream(model.id);
		const keys = [entryKey(model), accountKey(model.provider)];
		if (upstream !== undefined) keys.push(upstreamKey(model.provider, upstream));
		for (const key of keys) {
			this.cooldowns.clear(key);
			this.holdErrors.delete(key);
		}
	}

	private heldKey(model: ModelRef): string | undefined {
		const account = accountKey(model.provider);
		if (this.cooldowns.isSuppressed(account)) return account;
		const upstream = modelUpstream(model.id);
		if (upstream === undefined) return undefined;
		const key = upstreamKey(model.provider, upstream);
		return this.cooldowns.isSuppressed(key) ? key : undefined;
	}

	/** The upstream an account-scoped failure binds on a multi-upstream provider, or undefined for the whole account. */
	private upstreamOf(model: ModelRef, errorMessage: string | undefined): string | undefined {
		const named = errorMessage === undefined ? undefined : failureUpstream(errorMessage);
		if (named === undefined || modelUpstream(model.id) !== named) return undefined;
		const served = this.registry
			.getAll()
			.some((entry) => entry.provider === model.provider && modelUpstream(entry.id) !== named);
		return served ? named : undefined;
	}
}

function accountKey(provider: string): string {
	// This is a provider-name approximation, not resolved credential/account identity:
	// a failure that names no upstream holds every model behind the provider name.
	// Pooled slots can reset earlier than the last surfaced account error; a response
	// the provider serves, or an explicit /model selection, releases it.
	return `account:${provider}`;
}

function upstreamKey(provider: string, upstream: string): string {
	return `upstream:${provider}:${upstream}`;
}

function entryKey(model: ModelRef): string {
	return `exhausted:${model.provider}/${model.id}`;
}
