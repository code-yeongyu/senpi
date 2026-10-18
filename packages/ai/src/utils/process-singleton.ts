/**
 * Returns the one value this process keeps under `key`, creating it on first use.
 *
 * Module-level state that every copy of a module must share lives here instead of in a
 * module-local binding: the release bundle emits some providers as self-contained chunks
 * that carry their own copy of the modules they import (#2334), so a module-local `Map`
 * or `Set` would silently split into one instance per copy.
 */
export function processSingleton<T extends object>(key: string, create: () => T): T {
	const slot = Symbol.for(key);
	const existing: T | undefined = Reflect.get(globalThis, slot);
	if (existing !== undefined) return existing;
	const created = create();
	Reflect.set(globalThis, slot, created);
	return created;
}
