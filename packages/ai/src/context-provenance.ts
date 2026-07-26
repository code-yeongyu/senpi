/**
 * Request-local context provenance. Providers keep this metadata out of their
 * wire payloads while allowing a context producer to prove that a transformed
 * input item still represents the same source message.
 */
export const CONTEXT_PROVENANCE_FIELD = "__piContextProvenance";

export type ContextProvenance = Record<string, unknown>;

type ContextProvenanceCarrier = {
	[CONTEXT_PROVENANCE_FIELD]?: ContextProvenance;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getContextProvenance(value: unknown): ContextProvenance | undefined {
	if (!isRecord(value)) return undefined;
	const provenance = value[CONTEXT_PROVENANCE_FIELD];
	return isRecord(provenance) ? provenance : undefined;
}

/** Copy request-local provenance across a context representation change. */
export function copyContextProvenance<T extends object>(source: unknown, target: T): T {
	const provenance = getContextProvenance(source);
	return provenance ? Object.assign(target, { [CONTEXT_PROVENANCE_FIELD]: provenance }) : target;
}

/**
 * Stable within one request and intentionally never serialized to a provider.
 * A mismatch is proof that a context hook changed a marked source message.
 */
export function contextProvenanceFingerprint(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const clone = { ...value } as ContextProvenanceCarrier;
	delete clone[CONTEXT_PROVENANCE_FIELD];
	return JSON.stringify(clone);
}
