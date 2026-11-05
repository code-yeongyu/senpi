import type { PresenterAccountAuthority } from "./modes/rpc/mcp-presenter-account.ts";

/**
 * How an embedding distribution hands the RPC host its `PresenterAccountAuthority` (D11, senpi#4249).
 *
 * The distribution's entry calls `registerPresenterAccountAuthority` before it loads the CLI; `main()` calls
 * `takePresenterAccountAuthority` as its first statement, which seals the slot whether or not anything was registered.
 * From then on no code (an extension, a session, a later import) can fill or replace it. The slot is process-global
 * (`Symbol.for`) because a bundled run hands off to a runtime-snapshot COPY of the engine: a module-local variable would
 * not be the one that copy reads. Its value is a frozen pair of functions with the state in this closure, so it cannot be
 * written directly. This module has no other imports, so a distribution can load it without evaluating the engine.
 */

export type PresenterAuthorityRegistrationRefusal =
	| "presenter_authority_already_registered"
	| "presenter_authority_sealed";

class PresenterAuthorityRegistrationError extends Error {
	readonly code: PresenterAuthorityRegistrationRefusal;
	constructor(code: PresenterAuthorityRegistrationRefusal) {
		super(code);
		this.name = "PresenterAuthorityRegistrationError";
		this.code = code;
	}
}

interface Slot {
	register(authority: PresenterAccountAuthority): void;
	take(): PresenterAccountAuthority | undefined;
}

const SLOT_KEY = Symbol.for("senpi.presenterAccountAuthority.v1");

function createSlot(sealedEmpty = false): Slot {
	let authority: PresenterAccountAuthority | undefined;
	let sealed = sealedEmpty;
	return Object.freeze({
		register(next: PresenterAccountAuthority) {
			if (sealed) throw new PresenterAuthorityRegistrationError("presenter_authority_sealed");
			if (authority) throw new PresenterAuthorityRegistrationError("presenter_authority_already_registered");
			authority = next;
		},
		take() {
			sealed = true;
			return authority;
		},
	});
}

const isSlot = (value: unknown): value is Slot =>
	typeof value === "object" && value !== null && "register" in value && "take" in value;

const pin = (value: Slot): Slot => {
	Object.defineProperty(globalThis, SLOT_KEY, { value, writable: false, configurable: false, enumerable: false });
	return value;
};

function slot(): Slot {
	const existing = Reflect.getOwnPropertyDescriptor(globalThis, SLOT_KEY);
	if (existing === undefined) return pin(createSlot());
	// Only a slot pinned the way pin() pins it is ours. Anything else was planted before this module ran: it reads as
	// empty and sealed, and is replaced by such a slot when it can be, so a later swap of the value changes nothing.
	if (existing.writable === false && existing.configurable === false && isSlot(existing.value)) return existing.value;
	return existing.configurable ? pin(createSlot(true)) : createSlot(true);
}

/**
 * @public package entry `@code-yeongyu/senpi/presenter-authority`, called by an embedding distribution before it loads
 * the CLI. Throws once a registration exists or main() has started.
 */
export function registerPresenterAccountAuthority(authority: PresenterAccountAuthority): void {
	slot().register(authority);
}

/** Seals the slot and returns its authority; later calls return the same value. Called first thing by `main()`. */
export function takePresenterAccountAuthority(): PresenterAccountAuthority | undefined {
	return slot().take();
}
