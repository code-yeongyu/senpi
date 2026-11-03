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
	/** Per scope, the last admitted lifecycle event: a later call or event waits for it. */
	const tails = new Map<string, Promise<unknown>>();
	const after = <T>(scope: string, step: () => Promise<T>): Promise<T> => {
		const run = (tails.get(scope) ?? Promise.resolve()).then(step, step);
		tails.set(
			scope,
			run.catch(() => undefined),
		);
		return run;
	};
	const touch = (scope: string) =>
		update(scope, async (record) => {
			if (record?.state !== "open") return;
			await write({ ...record, lastActiveAt: clock() }, "active", null);
		});

	const closeNow = async (record: ScopeRecord, terminate?: (resource: string) => Promise<StoreValue>) => {
		let current = record;
		for (const resource of Object.keys(record.resources)) {
			if (current.outcomes[resource] !== undefined) continue;
			if (terminate === undefined) throw new Error(`forced close of ${record.binding.scope} needs a terminate port`);
			const outcome = await terminate(resource);
			current = await update(record.binding.scope, async (latest) => {
				if (latest === undefined) throw new Error(`scope ${record.binding.scope} vanished`);
				const next = { ...latest, outcomes: { ...latest.outcomes, [resource]: outcome } };
				await write(next, "outcome", resource);
				return next;
			});
		}
		await update(record.binding.scope, async (latest) => {
			if (latest === undefined || latest.state === "closed") return;
			await write({ ...latest, state: "closed", resources: {} }, "close", null);
		});
	};

	return {
		read,
		open: (binding) =>
			update(binding.scope, async (record) => {
				if (record !== undefined)
					return JSON.stringify(record.binding) === JSON.stringify(binding) && record.state === "open"
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
				await touch(scope);
				return run();
			}),
		hold: (scope, resource, kind) =>
			update(scope, async (record) => {
				if (record?.state !== "open") throw new Error(`scope ${scope} is not open`);
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
		close: async (actor, scope, closeOptions = {}) => {
			const record = await read(scope);
			if (record === undefined) return { kind: "refused", reason: "unknown_scope" };
			if (record.binding.issuer !== actor) return { kind: "refused", reason: "not_issuer" };
			if (record.state === "closed") return { kind: "closed" };
			if (Object.keys(record.resources).length > 0 && closeOptions.force !== true)
				return { kind: "refused", reason: "live_resources" };
			await closeNow(record, closeOptions.terminate);
			return { kind: "closed" };
		},
		sweepIdle: async () => {
			const closed: string[] = [];
			for (const { data } of await store.scanDocuments(PREFIX)) {
				const record = decode(data);
				if (record.state !== "open" || Object.keys(record.resources).length > 0) continue;
				if (clock() - record.lastActiveAt <= idleTtlMs) continue;
				await closeNow(record);
				closed.push(record.binding.scope);
			}
			return closed;
		},
	};
}
