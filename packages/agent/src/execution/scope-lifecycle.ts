import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { canonicalJson } from "./canonical-json.ts";

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

/** A call for a scope that is unknown or closed: it never runs. */
export class ScopeUnavailableError extends Error {
	readonly scope: string;
	readonly reason: "unknown_scope" | "closed";
	constructor(scope: string, reason: "unknown_scope" | "closed") {
		super(`scope ${scope} is not open: ${reason}`);
		this.name = "ScopeUnavailableError";
		this.scope = scope;
		this.reason = reason;
	}
}

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
	/** Runs `run` after every lifecycle event of the scope submitted before it has committed; throws ScopeUnavailableError for a closed or unknown scope. */
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

const PREFIX = "execution.scope:";

const isObject = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function decode(value: StoreValue): ScopeRecord {
	if (
		isObject(value) &&
		isObject(value.binding) &&
		(value.state === "open" || value.state === "closed") &&
		typeof value.lastActiveAt === "number" &&
		isObject(value.resources) &&
		Array.isArray(value.events) &&
		isObject(value.outcomes)
	)
		return value as ScopeRecord;
	throw new Error("corrupt scope record");
}

export function createScopeLifecycle(options: ScopeLifecycleOptions): ScopeLifecycle {
	const { store, epoch, admission, clock, idleTtlMs } = options;
	const keyOf = (scope: string): string => `${PREFIX}${JSON.stringify([scope])}`;
	const read = async (scope: string): Promise<ScopeRecord | undefined> => {
		const value = await store.getDocument(keyOf(scope));
		return value === undefined ? undefined : decode(value);
	};
	const write = async (record: ScopeRecord, step: string, executionId: string | null): Promise<void> => {
		await store.commit(
			epoch,
			[
				{
					op: "append",
					id: store.mintId(),
					kind: "execution.scope",
					data: { scope: record.binding.scope, step, executionId },
				},
				{ op: "put", key: keyOf(record.binding.scope), data: record },
			],
			() => {},
		);
	};
	const update = <T>(scope: string, decide: (record: ScopeRecord | undefined) => Promise<T>): Promise<T> =>
		admission.admit(async () => decide(await read(scope)));
	/** Per scope, the last admitted lifecycle event or close: a later call, event or close waits for it. */
	const tails = new Map<string, Promise<unknown>>();
	const after = <T>(scope: string, step: () => Promise<T>): Promise<T> => {
		const run = (tails.get(scope) ?? Promise.resolve()).then(step, step);
		const settled = run.catch(() => undefined);
		tails.set(scope, settled);
		void settled.then(() => {
			if (tails.get(scope) === settled) tails.delete(scope);
		});
		return run;
	};
	const touch = (scope: string): Promise<ScopeRecord["state"] | undefined> =>
		update(scope, async (record) => {
			if (record?.state !== "open") return record?.state;
			await write({ ...record, lastActiveAt: clock() }, "active", null);
			return "open";
		});

	type CloseStep =
		| { readonly kind: "closed" }
		| { readonly kind: "refused"; readonly reason: ScopeRefusal }
		| { readonly kind: "terminate"; readonly pending: readonly string[] };
	/**
	 * Closes from the record as it is inside the admission line, so a resource held after any earlier read is seen: an
	 * unforced close with a live resource is refused; a forced one terminates each resource without an outcome, writes
	 * the outcome, and looks again until none is left.
	 */
	const finishClose = async (
		scope: string,
		force: boolean,
		terminate?: (resource: string) => Promise<StoreValue>,
	): Promise<{ readonly kind: "closed" } | { readonly kind: "refused"; readonly reason: ScopeRefusal }> => {
		for (;;) {
			const step = await update(scope, async (latest): Promise<CloseStep> => {
				if (latest === undefined) return { kind: "refused", reason: "unknown_scope" };
				if (latest.state === "closed") return { kind: "closed" };
				const pending = Object.keys(latest.resources).filter((resource) => latest.outcomes[resource] === undefined);
				if (pending.length > 0 && !force) return { kind: "refused", reason: "live_resources" };
				if (pending.length > 0) return { kind: "terminate", pending };
				await write({ ...latest, state: "closed", resources: {} }, "close", null);
				return { kind: "closed" };
			});
			if (step.kind !== "terminate") return step;
			if (terminate === undefined) throw new Error(`forced close of ${scope} needs a terminate port`);
			for (const resource of step.pending) {
				const outcome = await terminate(resource);
				await update(scope, async (latest) => {
					if (latest === undefined || latest.state === "closed" || latest.outcomes[resource] !== undefined) return;
					await write({ ...latest, outcomes: { ...latest.outcomes, [resource]: outcome } }, "outcome", resource);
				});
			}
		}
	};

	return {
		read,
		open: (binding) =>
			update(binding.scope, async (record) => {
				if (!Number.isFinite(binding.generation))
					throw new Error(`scope ${binding.scope} has a non-finite generation`);
				if (record !== undefined)
					return canonicalJson(record.binding) === canonicalJson(binding) && record.state === "open"
						? ({ kind: "opened" } as const)
						: ({ kind: "refused", reason: "conflicting_scope" } as const);
				await write(
					{ binding, state: "open", lastActiveAt: clock(), resources: {}, events: [], outcomes: {} },
					"open",
					null,
				);
				return { kind: "opened" } as const;
			}),
		lifecycle: (actor, scope, kind, handler) =>
			after(scope, async () => {
				const record = await read(scope);
				if (record === undefined) return { kind: "refused", reason: "unknown_scope" } as const;
				if (record.binding.issuer !== actor) return { kind: "refused", reason: "not_issuer" } as const;
				if (record.state === "closed") return { kind: "refused", reason: "closed" } as const;
				const effect = await handler();
				return update(scope, async (latest) => {
					if (latest === undefined || latest.state === "closed")
						return { kind: "refused", reason: "closed" } as const;
					const seq = latest.events.length + 1;
					await write(
						{ ...latest, lastActiveAt: clock(), events: [...latest.events, { seq, kind, effect }] },
						"lifecycle",
						`${kind}#${seq}`,
					);
					return { kind: "committed", seq } as const;
				});
			}),
		call: (scope, run) =>
			(tails.get(scope) ?? Promise.resolve()).then(async () => {
				const state = await touch(scope);
				if (state !== "open")
					throw new ScopeUnavailableError(scope, state === undefined ? "unknown_scope" : "closed");
				return run();
			}),
		hold: (scope, resource, kind) =>
			update(scope, async (record) => {
				if (record?.state !== "open")
					throw new ScopeUnavailableError(scope, record === undefined ? "unknown_scope" : "closed");
				await write(
					{ ...record, lastActiveAt: clock(), resources: { ...record.resources, [resource]: kind } },
					"hold",
					resource,
				);
			}),
		release: (scope, resource) =>
			update(scope, async (record) => {
				if (record === undefined || record.resources[resource] === undefined) return;
				const { [resource]: _released, ...resources } = record.resources;
				await write({ ...record, lastActiveAt: clock(), resources }, "release", resource);
			}),
		close: (actor, scope, closeOptions = {}) =>
			after(scope, async () => {
				const record = await read(scope);
				if (record === undefined) return { kind: "refused", reason: "unknown_scope" } as const;
				if (record.binding.issuer !== actor) return { kind: "refused", reason: "not_issuer" } as const;
				return finishClose(scope, closeOptions.force === true, closeOptions.terminate);
			}),
		sweepIdle: async () => {
			const closed: string[] = [];
			for (const { data } of await store.scanDocuments(PREFIX)) {
				const candidate = decode(data);
				const scope = candidate.binding.scope;
				if (candidate.state !== "open" || Object.keys(candidate.resources).length > 0) continue;
				if (clock() - candidate.lastActiveAt <= idleTtlMs) continue;
				const done = await after(scope, () =>
					update(scope, async (latest) => {
						if (latest?.state !== "open" || Object.keys(latest.resources).length > 0) return false;
						if (clock() - latest.lastActiveAt <= idleTtlMs) return false;
						await write({ ...latest, state: "closed" }, "close", null);
						return true;
					}),
				);
				if (done) closed.push(scope);
			}
			return closed;
		},
	};
}
