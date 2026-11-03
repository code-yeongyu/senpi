import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";

/** What an endpoint owns for one scope (design 5.6.6). */
export type ScopeBinding = {
	readonly issuer: string;
	readonly workspace: string;
	readonly scope: string;
	readonly generation: number;
	readonly allowedRoots: readonly string[];
};

export type ScopeRecord = {
	readonly binding: ScopeBinding;
	readonly state: "open" | "closed";
	readonly lastActiveAt: number;
	/** Live resources (executions, terminals, activities) by id: an idle TTL never closes a scope that holds one. */
	readonly resources: { readonly [id: string]: string };
	/** Every committed lifecycle event, in admission order, with the effect its handler returned. */
	readonly events: readonly { readonly seq: number; readonly kind: string; readonly effect: StoreValue }[];
	/** Terminal outcomes a forced close wrote, by resource id, before the scope closed. */
	readonly outcomes: { readonly [id: string]: StoreValue };
};

export type ScopeRefusal = "unknown_scope" | "not_issuer" | "closed" | "live_resources" | "conflicting_scope";

export interface ScopeLifecycleOptions {
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
	readonly idleTtlMs: number;
}

/**
 * Scope lifecycle on an endpoint (design 5.6.6). A lifecycle event is admitted only after its handler's effect commits,
 * and a call submitted after it runs only then; only the issuer closes; a TTL never closes a scope with live resources;
 * a forced close writes every live resource's terminal outcome before the scope closes.
 */
export interface ScopeLifecycle {
	open(
		binding: ScopeBinding,
	): Promise<{ readonly kind: "opened" } | { readonly kind: "refused"; readonly reason: ScopeRefusal }>;
	lifecycle(
		actor: string,
		scope: string,
		kind: string,
		handler: () => Promise<StoreValue>,
	): Promise<
		{ readonly kind: "committed"; readonly seq: number } | { readonly kind: "refused"; readonly reason: ScopeRefusal }
	>;
	/** Runs `run` after every lifecycle event of the scope submitted before it has committed. */
	call<T>(scope: string, run: () => Promise<T>): Promise<T>;
	hold(scope: string, resource: string, kind: string): Promise<void>;
	release(scope: string, resource: string): Promise<void>;
	close(
		actor: string,
		scope: string,
		options?: { readonly force?: boolean; readonly terminate?: (resource: string) => Promise<StoreValue> },
	): Promise<{ readonly kind: "closed" } | { readonly kind: "refused"; readonly reason: ScopeRefusal }>;
	/** Closes every open scope idle longer than the TTL that holds no live resource; returns their names. */
	sweepIdle(): Promise<readonly string[]>;
	read(scope: string): Promise<ScopeRecord | undefined>;
}

export function createScopeLifecycle(_options: ScopeLifecycleOptions): ScopeLifecycle {
	return {
		read: async () => undefined,
		open: async () => ({ kind: "opened" }),
		lifecycle: async () => ({ kind: "committed", seq: 0 }),
		call: (_scope, run) => run(),
		hold: async () => {},
		release: async () => {},
		close: async () => ({ kind: "closed" }),
		sweepIdle: async () => [],
	};
}
