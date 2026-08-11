/**
 * Wire identity of the running product.
 *
 * Requests carry a product token in the user agent and, for providers that ask for it, an
 * originator. A distribution repackaging this stack sets its own token once at startup; the
 * default keeps the engine's identity so a standalone install is unchanged.
 */

const DEFAULT_WIRE_IDENTITY = "senpi";

let wireIdentity = DEFAULT_WIRE_IDENTITY;

/** Sets the product token used on outgoing requests. Ignores empty input. */
export function setWireIdentity(identity: string | undefined): void {
	if (identity?.trim()) {
		wireIdentity = identity.trim();
	}
}

/** Product token used on outgoing requests. */
export function getWireIdentity(): string {
	return wireIdentity;
}

/** exported for tests only */
export function resetWireIdentityForTests(): void {
	wireIdentity = DEFAULT_WIRE_IDENTITY;
}
