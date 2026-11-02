import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

// Optional OAuth response fields some servers send as `null` or `""` instead of omitting them. The SDK's
// schemas reject `null` (refresh_token, client_secret, ...) and coerce `expires_in: null` to 0, which would
// store an already-expired token, so they are dropped before the SDK parses the body.
const OPTIONAL_OAUTH_FIELDS = new Set([
	"expires_in",
	"refresh_token",
	"scope",
	"id_token",
	"client_secret",
	"client_secret_expires_at",
	"client_id_issued_at",
	"registration_access_token",
	"registration_client_uri",
]);

function withoutAbsentOptionalFields(body: unknown): unknown {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (OPTIONAL_OAUTH_FIELDS.has(key) && (value === null || value === "")) {
			changed = true;
			continue;
		}
		next[key] = value;
	}
	return changed ? next : body;
}

export function oauthFetch(base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
	return async (input, init) => {
		const response = await base(input, init);
		if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return new Response(text, response);
		}
		const normalized = withoutAbsentOptionalFields(body);
		return new Response(normalized === body ? text : JSON.stringify(normalized), response);
	};
}
