import path, { posix, win32 } from "node:path";

type PathRules = typeof posix;

/**
 * Vendored contract: the old-location breadcrumb the OmO desktop leaves at a data root it moved
 * (omo-desktop-app `packages/shared/src/appHomePrepare.ts`, step M6 of the data-home move, #1829).
 * Both repositories validate it identically and commit the same v1 fixture; any change bumps
 * `schemaVersion` and lands in both. senpi#2898.
 */
export const MOVED_BREADCRUMB_FILE = "omo-desktop-moved.json";
export const MOVED_BREADCRUMB_KIND = "omo-desktop-moved";
export const MOVED_BREADCRUMB_SCHEMA_VERSION = 1;

export interface MovedBreadcrumb {
	/** Absolute, normalized path of the new data root, on this host's path rules. */
	readonly movedTo: string;
	/** The moved home's id; its ownership marker must carry the same one. */
	readonly homeId: string;
	/** The moved prefixes, relative to the breadcrumb's directory, as path segments. */
	readonly moved: readonly (readonly string[])[];
}

export type BreadcrumbParse =
	| { readonly kind: "valid"; readonly breadcrumb: MovedBreadcrumb }
	| { readonly kind: "ignored"; readonly reason: string };

function ignored(reason: string): BreadcrumbParse {
	return { kind: "ignored", reason };
}

function prefixSegments(prefix: unknown): string[] | undefined {
	if (typeof prefix !== "string" || posix.isAbsolute(prefix) || win32.isAbsolute(prefix)) return undefined;
	const segments = prefix.split(/[\\/]/).filter((segment) => segment.length > 0);
	if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return undefined;
	return segments;
}

/** Absolute on the host's own rules and already normalized: no `..`, no `.`, no trailing separator. */
function isNormalizedAbsolute(value: string, host: PathRules): boolean {
	if (!host.isAbsolute(value) || host.normalize(value) !== value) return false;
	return value === host.parse(value).root || !(value.endsWith("/") || value.endsWith(host.sep));
}

export function parseMovedBreadcrumb(raw: unknown, host: PathRules = path): BreadcrumbParse {
	if (typeof raw !== "object" || raw === null) return ignored("not an object");
	const record = raw as Record<string, unknown>;
	if (record.kind !== MOVED_BREADCRUMB_KIND) return ignored("foreign kind");
	const version = record.schemaVersion;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
		return ignored("invalid schemaVersion");
	if (version > MOVED_BREADCRUMB_SCHEMA_VERSION) return ignored(`unsupported schemaVersion ${version}`);
	const movedTo = record.movedTo;
	if (typeof movedTo !== "string" || !isNormalizedAbsolute(movedTo, host))
		return ignored("movedTo is not a normalized absolute path on this host");
	const homeId = record.homeId;
	if (typeof homeId !== "string" || homeId.length === 0) return ignored("homeId is missing");
	if (!Array.isArray(record.moved)) return ignored("moved is not an array");
	const moved: string[][] = [];
	for (const prefix of record.moved) {
		const segments = prefixSegments(prefix);
		if (!segments) return ignored(`invalid moved prefix ${JSON.stringify(prefix)}`);
		moved.push(segments);
	}
	return { kind: "valid", breadcrumb: { movedTo, homeId, moved } };
}
