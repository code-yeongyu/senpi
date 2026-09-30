/** The JWT claim holding the ChatGPT account that owns a Codex credential. */
export const CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH = "https://api.openai.com/auth";

const CHATGPT_SUBSCRIPTION_ISSUER = "https://auth.openai.com";
const CHATGPT_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_SUBSCRIPTION_JWKS_URL = `${CHATGPT_SUBSCRIPTION_ISSUER}/.well-known/jwks.json`;
const PRINTABLE_EMAIL_PATTERN =
	/^[^\s@\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+@[^\s@\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+\.[^\s@\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

export type ChatGptSubscriptionVerifiedIdentity = {
	readonly userId: string;
	readonly workspaceId: string;
	readonly verifiedEmail?: string;
};

type IdentityValidationOptions = {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
};

function decodeJwtPart(value: string): unknown {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function verifiedEmail(value: unknown): string | undefined {
	return typeof value === "string" && PRINTABLE_EMAIL_PATTERN.test(value) ? value : undefined;
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

/**
 * Verifies optional OIDC identity enrichment. Invalid tokens deliberately
 * return no identity so a valid access-token login remains usable.
 */
export async function validateChatGptSubscriptionIdentity(
	idToken: string,
	options: IdentityValidationOptions = {},
): Promise<ChatGptSubscriptionVerifiedIdentity | undefined> {
	try {
		const parts = idToken.split(".");
		if (parts.length !== 3) return undefined;
		const [encodedHeader, encodedPayload, encodedSignature] = parts;
		if (!encodedHeader || !encodedPayload || !encodedSignature) return undefined;
		const header = stringRecord(decodeJwtPart(encodedHeader));
		const claims = stringRecord(decodeJwtPart(encodedPayload));
		const kid = nonemptyString(header?.kid);
		if (header?.alg !== "RS256" || kid === undefined || claims === undefined) return undefined;

		const response = await (options.fetch ?? fetch)(CHATGPT_SUBSCRIPTION_JWKS_URL, { signal: options.signal });
		if (!response.ok) return undefined;
		const jwks = stringRecord(await response.json());
		const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
		const jwk = keys.map(stringRecord).find((key) => key?.kid === kid && key.alg === "RS256");
		if (jwk === undefined) return undefined;
		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
			"verify",
		]);
		const signature = Uint8Array.from(atob(encodedSignature.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
			c.charCodeAt(0),
		);
		if (
			!(await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				key,
				signature,
				new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
			))
		)
			return undefined;

		const audience = claims.aud;
		const audienceMatches =
			audience === CHATGPT_SUBSCRIPTION_CLIENT_ID ||
			(Array.isArray(audience) && audience.includes(CHATGPT_SUBSCRIPTION_CLIENT_ID));
		const authorizedPartyMatches =
			claims.azp === undefined
				? !Array.isArray(audience) || audience.length <= 1
				: claims.azp === CHATGPT_SUBSCRIPTION_CLIENT_ID;
		const expiresMs = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
		if (
			claims.iss !== CHATGPT_SUBSCRIPTION_ISSUER ||
			!audienceMatches ||
			!authorizedPartyMatches ||
			expiresMs === undefined ||
			!Number.isFinite(expiresMs)
		) {
			return undefined;
		}
		if (expiresMs <= (options.now ?? Date.now)()) return undefined;
		const auth = stringRecord(claims[CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH]);
		const userId = nonemptyString(claims.sub) ?? nonemptyString(auth?.chatgpt_user_id);
		const workspaceId = nonemptyString(auth?.chatgpt_account_id);
		if (userId === undefined || workspaceId === undefined) return undefined;
		const email = claims.email_verified === true ? verifiedEmail(claims.email) : undefined;
		return email === undefined ? { userId, workspaceId } : { userId, workspaceId, verifiedEmail: email };
	} catch {
		options.signal?.throwIfAborted();
		return undefined;
	}
}

/**
 * Reads the stable ChatGPT account identifier from a Codex access token.
 *
 * This deliberately uses only browser primitives so request code and OAuth
 * code can share it without pulling Node-only authentication modules into
 * browser consumers.
 */
export function extractChatGptSubscriptionAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		const encodedPayload = parts.length === 3 ? parts[1] : undefined;
		if (!encodedPayload) return undefined;
		const payload = stringRecord(decodeJwtPart(encodedPayload));
		if (payload === undefined) return undefined;
		const auth = stringRecord(payload[CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH]);
		return nonemptyString(auth?.chatgpt_account_id);
	} catch {
		return undefined;
	}
}
