import type { ProviderDiagnostic } from "../provider-diagnostic.ts";

/**
 * Adapter-owned side channel for a diagnostic that rides along a thrown provider
 * error. The error keeps its exact message and identity; the diagnostic lives in
 * a WeakMap so a property an error declares about itself can never be read as one.
 */
const carrier = new WeakMap<object, ProviderDiagnostic>();

export function attachProviderDiagnostic<E extends object>(error: E, diagnostic: ProviderDiagnostic | undefined): E {
	if (diagnostic !== undefined) carrier.set(error, diagnostic);
	return error;
}

/** Raw lookup; callers revalidate before exposing the value. */
export function peekProviderDiagnostic(error: unknown): ProviderDiagnostic | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	return carrier.get(error);
}
