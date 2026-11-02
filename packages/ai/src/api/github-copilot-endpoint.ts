// The Copilot API host is per account plan (individual, business, enterprise, data-residency
// tenants). A request sent to another plan's host is refused with `421 Misdirected Request`,
// so the host always comes from the account's own token; the individual host is a last resort.

export const GITHUB_COPILOT_INDIVIDUAL_BASE_URL = "https://api.individual.githubcopilot.com";

export interface GitHubCopilotApiEndpoint {
	readonly tid: string;
	readonly url: string;
}

export function githubCopilotTokenField(token: string, key: string): string | undefined {
	for (const part of token.split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator) === key) return part.slice(separator + 1) || undefined;
	}
	return undefined;
}

export function githubCopilotBaseUrlFromToken(token: string): string | undefined {
	const proxyHost = githubCopilotTokenField(token, "proxy-ep");
	return proxyHost ? `https://${proxyHost.replace(/^proxy\./, "api.")}` : undefined;
}

export function parseGitHubCopilotApiEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return undefined;
	}
}

function endpointForToken(endpoint: unknown, token: string | undefined): string | undefined {
	if (!token || typeof endpoint !== "object" || endpoint === null) return undefined;
	const tid = Reflect.get(endpoint, "tid");
	const url = parseGitHubCopilotApiEndpoint(Reflect.get(endpoint, "url"));
	return typeof tid === "string" && tid === githubCopilotTokenField(token, "tid") ? url : undefined;
}

/**
 * The account's Copilot API base URL, in order: the token response's `endpoints.api` recorded for
 * this exact token (matched by `tid`, so a pooled sibling account never borrows it), the token's
 * `proxy-ep`, the GitHub Enterprise Server domain, then the individual host.
 */
export function resolveGitHubCopilotBaseUrl(input: {
	token?: string;
	apiEndpoint?: unknown;
	enterpriseDomain?: string;
}): string {
	return (
		endpointForToken(input.apiEndpoint, input.token) ??
		(input.token ? githubCopilotBaseUrlFromToken(input.token) : undefined) ??
		(input.enterpriseDomain ? `https://copilot-api.${input.enterpriseDomain}` : undefined) ??
		GITHUB_COPILOT_INDIVIDUAL_BASE_URL
	);
}
