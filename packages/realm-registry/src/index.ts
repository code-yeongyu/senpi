/**
 * One registry instance per JavaScript realm, whatever number of engine copies load (omo#12965).
 *
 * A process can evaluate senpi's engine modules more than once (the bundled CLI next to the SDK graph a plugin imports,
 * a re-evaluated extension generation, an embedder's second install). A table one copy writes and another reads must
 * therefore not live in module scope. Each such table is a frozen interface object whose state lives only in the
 * closure of the copy that created it, pinned on `globalThis` under `Symbol.for(keyName)` (non-writable,
 * non-configurable, non-enumerable). Every later copy adopts that instance and calls through its functions: nothing
 * crosses copies through class identity, and readers validate every value that does.
 *
 * Permanent contract: a key name never changes; its v1 members are never removed or repurposed, and later versions only
 * add members, so a copy adopts any pinned, frozen object that satisfies the v1 check and ignores members it does not
 * know. A slot that is not pinned that way (planted before senpi loaded, an accessor, another shape) is refused with a
 * typed error that names the key and never a value. Workers, `vm` contexts and child processes are other realms and
 * hold their own instances. This package holds no state of its own, so every inlined copy applies one rule.
 */

export const REALM_REGISTRY_FOREIGN = "SENPI_REALM_REGISTRY_FOREIGN";

export class RealmRegistryError extends Error {
	readonly code: typeof REALM_REGISTRY_FOREIGN;
	readonly key: string;
	constructor(keyName: string, cause?: unknown) {
		super(
			`The process-wide registry ${keyName} was not installed by senpi or is incompatible; restart the process.`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "RealmRegistryError";
		this.code = REALM_REGISTRY_FOREIGN;
		this.key = keyName;
	}
}

/** Builds the error a refused slot raises; the redaction registry keeps its own class and code (senpi#6334). */
export type RealmRegistryRefusal = (cause?: unknown) => Error;

function foreignRegistry(keyName: string): RealmRegistryRefusal {
	return (cause) => new RealmRegistryError(keyName, cause);
}

function adopted<T extends object>(
	slot: PropertyDescriptor,
	isV1: (value: unknown) => value is T,
	refuse: RealmRegistryRefusal,
): T {
	const value: unknown = slot.value;
	if (
		!("value" in slot) ||
		slot.writable !== false ||
		slot.configurable !== false ||
		typeof value !== "object" ||
		value === null ||
		!Object.isFrozen(value) ||
		!isV1(value)
	) {
		throw refuse();
	}
	return value;
}

/**
 * The realm's single instance under `keyName`: the pinned one when it exists and satisfies `isV1`, else the frozen
 * object `create()` builds, pinned now. Throws `refuse()` (by default `RealmRegistryError`) for any other slot value.
 */
export function realmRegistry<T extends object>(
	keyName: string,
	create: () => T,
	isV1: (value: unknown) => value is T,
	refuse?: RealmRegistryRefusal,
): T {
	const refusal = refuse ?? foreignRegistry(keyName);
	const key = Symbol.for(keyName);
	const slot = Reflect.getOwnPropertyDescriptor(globalThis, key);
	if (slot !== undefined) return adopted(slot, isV1, refusal);
	const instance = Object.freeze(create());
	try {
		Object.defineProperty(globalThis, key, {
			value: instance,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	} catch (error) {
		throw refusal(error);
	}
	return instance;
}

/** The realm's instance under `keyName` without ever creating one: `undefined` when none exists yet. */
export function realmRegistryLookup<T extends object>(
	keyName: string,
	isV1: (value: unknown) => value is T,
	refuse?: RealmRegistryRefusal,
): T | undefined {
	const slot = Reflect.getOwnPropertyDescriptor(globalThis, Symbol.for(keyName));
	return slot === undefined ? undefined : adopted(slot, isV1, refuse ?? foreignRegistry(keyName));
}

/** Whether `value` has every named member as a function, the usual v1 check. */
export function hasFunctions(value: unknown, names: readonly string[]): boolean {
	if (typeof value !== "object" || value === null) return false;
	return names.every((name) => typeof Reflect.get(value, name) === "function");
}
