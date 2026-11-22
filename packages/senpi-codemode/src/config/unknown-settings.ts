/**
 * A settings file written for a newer senpi may name keys this version does not know: they are dropped with
 * one warning each instead of failing the whole file, so the user's other settings still apply. Only the
 * top level is lenient; the known nested objects keep their strict schemas.
 */
export function withoutUnknownTopLevelKeys(
	parsed: unknown,
	known: ReadonlySet<string>,
	path: string,
): { readonly value: unknown; readonly warnings: string[] } {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { value: parsed, warnings: [] };
	const kept: Record<string, unknown> = {};
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		if (known.has(key)) kept[key] = value;
		else warnings.push(`Unknown codemode setting "${key}" in ${path} is ignored; the other settings still apply.`);
	}
	return { value: kept, warnings };
}
