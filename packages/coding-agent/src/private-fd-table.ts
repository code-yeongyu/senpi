/**
 * The one decoder of the private descriptor table (senpi#4749), shared by the table's owner (`private-fds.ts`)
 * and the startup stub's filler release (`private-fd-startup-fillers.ts`). Side-effect free on purpose: the stub
 * runs before `private-fds.ts` adopts the table at import, so nothing here may import that module.
 */
export const PRIVATE_FDS_TABLE_ENV = "SENPI_PRIVATE_FDS";
/** Forwarded in place of a table that was present but yielded no names, so every hop reads the same state. */
export const UNPARSEABLE_TABLE = "unparseable";
const MAX_TABLE_CHARS = 4096;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const QUOTED_NAME = /"([a-z][a-z0-9-]{0,63})"\s*:/g;

/**
 * A parsed table keeps its valid-name `entries`, and every entry's value in `values`: a descriptor under a
 * refused name is still named by the launcher. A table that does not parse keeps only the names it still quotes.
 */
export type DecodedPrivateFdTable =
	| {
			readonly parsed: true;
			readonly entries: readonly (readonly [string, unknown])[];
			readonly values: readonly unknown[];
	  }
	| { readonly parsed: false; readonly names: readonly string[] };

export function decodePrivateFdTable(encoded: string): DecodedPrivateFdTable {
	let value: unknown;
	try {
		value = encoded.length > MAX_TABLE_CHARS ? undefined : JSON.parse(encoded);
	} catch {
		value = undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		const names: string[] = [];
		for (const match of encoded.slice(0, MAX_TABLE_CHARS).matchAll(QUOTED_NAME)) {
			if (match[1] !== undefined) names.push(match[1]);
		}
		return { parsed: false, names };
	}
	return {
		parsed: true,
		entries: Object.entries(value).filter(([name]) => NAME.test(name)),
		values: Object.values(value),
	};
}
