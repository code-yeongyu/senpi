/**
 * GitLab Duo direct-access token exchange (browser-safe).
 * Network-only; no Node callback server.
 */

const GITLAB_DUO_BASE_URL = "https://gitlab.com";
const REQUEST_TIMEOUT_MS = 30_000;
const DIRECT_ACCESS_TTL_MS = 25 * 60_000;

type DirectAccess = { token: string; headers: Record<string, string>; expiresAt: number };

const directAccessCache = new Map<string, DirectAccess>();

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Clear cached direct-access tokens (e.g. after OAuth token rotation). */
export function clearGitLabDuoDirectAccessCache(): void {
	directAccessCache.clear();
}

export async function getGitLabDuoDirectAccess(
	accessToken: string,
	signal?: AbortSignal,
): Promise<{ token: string; headers: Record<string, string> }> {
	if (!accessToken) throw new Error("GitLab Duo credentials do not include an access token");
	const cached = directAccessCache.get(accessToken);
	if (cached && cached.expiresAt > Date.now()) return cached;
	let response: Response;
	try {
		response = await fetch(`${GITLAB_DUO_BASE_URL}/api/v4/ai/third_party_agents/direct_access`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new Error("GitLab Duo direct-access request failed");
	}
	if (!response.ok) throw new Error(`GitLab Duo direct-access request failed (${response.status})`);
	const data = (await response.json()) as Record<string, unknown>;
	if (typeof data.token !== "string" || !data.token || !data.headers || typeof data.headers !== "object") {
		throw new Error("GitLab Duo direct-access response missing required fields");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(data.headers as Record<string, unknown>)) {
		if (typeof value === "string") headers[key] = value;
	}
	const directAccess = { token: data.token, headers, expiresAt: Date.now() + DIRECT_ACCESS_TTL_MS };
	directAccessCache.set(accessToken, directAccess);
	return directAccess;
}
