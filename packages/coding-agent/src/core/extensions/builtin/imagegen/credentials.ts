export interface CredentialParts {
	apiKey: string | undefined;
	headers?: Record<string, string>;
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function sameBaseUrl(left: string, right: string): boolean {
	return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function resolvedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string" && value.trim().length > 0) resolved[name] = value;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Seeded placeholder keys (`SK-SENTINEL-DO-NOT-LOG-*`) are not credentials. Left unfiltered, such a
 * value satisfies the stored-openai branch, pins `api.openai.com`, and every request 401s with
 * `Incorrect API key provided: SK-SENTI***OG-2` while a working gateway sits unused.
 */
export function isPlaceholderKey(apiKey: string): boolean {
	return /^SK-SENTINEL-DO-NOT-LOG/i.test(apiKey);
}

export function credentialParts(
	auth: { apiKey?: string; headers?: Record<string, string | null> } | undefined,
): CredentialParts | undefined {
	const apiKey = nonEmpty(auth?.apiKey);
	if (!apiKey || isPlaceholderKey(apiKey)) return undefined;
	const headers = resolvedHeaders(auth?.headers);
	return { apiKey, ...(headers ? { headers } : {}) };
}
