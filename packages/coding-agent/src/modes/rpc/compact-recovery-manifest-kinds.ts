import { CATALOG_FAMILIES, type CatalogFamily, type FamilyRegistry } from "./compact-catalog-registry.ts";

export type RequiredKindsRefusal =
	| "manifest_missing_required_kinds"
	| "manifest_unknown_required_kind"
	| "manifest_required_kinds_mismatch";

export type RequiredKindsRead =
	| { readonly ok: true; readonly requiredKinds: readonly CatalogFamily[] }
	| { readonly ok: false; readonly code: RequiredKindsRefusal };

const KNOWN: ReadonlySet<string> = new Set(CATALOG_FAMILIES);
const isKnown = (kind: unknown): kind is CatalogFamily => typeof kind === "string" && KNOWN.has(kind);

/**
 * The families a client opens for one decoded manifest (RULING-128): its `requiredKinds`, read verbatim and never
 * replaced by a built-in family list. `registry` is the cut's `families/families` component as `readFamilyRegistry`
 * decodes it from bytes verified against the root entry that `checkpointDigest` covers. The digest covers that
 * component, not the manifest field, so the list opens only when it equals the component's complete families.
 */
export function readRequiredKinds(manifest: unknown, registry: FamilyRegistry): RequiredKindsRead {
	const listed =
		typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "requiredKinds") : undefined;
	if (!Array.isArray(listed)) return { ok: false, code: "manifest_missing_required_kinds" };
	if (!listed.every(isKnown)) return { ok: false, code: "manifest_unknown_required_kind" };
	const complete = registry.requiredKinds;
	if (listed.length !== complete.length || listed.some((kind, index) => kind !== complete[index]))
		return { ok: false, code: "manifest_required_kinds_mismatch" };
	return { ok: true, requiredKinds: complete };
}
