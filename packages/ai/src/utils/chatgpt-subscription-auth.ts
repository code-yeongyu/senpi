/** The JWT claim holding the ChatGPT account that owns a Codex credential. */
export const CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Reads the stable ChatGPT account identifier from a Codex access token.
 *
 * This deliberately uses only browser primitives so request code and OAuth
 * code can share it without pulling Node-only authentication modules into
 * browser consumers.
 */
export function extractChatGptSubscriptionAccountId(token: string): string | undefined {
	return claimString(authClaims(token), "chatgpt_account_id");
}

/**
 * The signed-in person a Codex access token belongs to, for telling one saved account from another.
 * `chatgpt_account_id` names the workspace and is shared by every member of a Team workspace, so the
 * identity is the per-member `chatgpt_account_user_id`, or the user id scoped to the workspace when
 * that claim is absent. A token without either has no identity.
 */
export function extractChatGptSubscriptionIdentity(token: string): string | undefined {
	const auth = authClaims(token);
	const workspace = claimString(auth, "chatgpt_account_id");
	const user = claimString(auth, "chatgpt_user_id") ?? claimString(auth, "user_id");
	return (
		claimString(auth, "chatgpt_account_user_id") ??
		(user !== undefined && workspace !== undefined ? `${user}/${workspace}` : undefined)
	);
}

function authClaims(token: string): object | undefined {
	try {
		const parts = token.split(".");
		const encodedPayload = parts.length === 3 ? parts[1] : undefined;
		if (!encodedPayload) return undefined;
		const base64 = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
		const payload: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
		if (!payload || typeof payload !== "object") return undefined;
		const auth = Reflect.get(payload, CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH);
		return auth && typeof auth === "object" ? auth : undefined;
	} catch {
		return undefined;
	}
}

function claimString(claims: object | undefined, key: string): string | undefined {
	const value = claims === undefined ? undefined : Reflect.get(claims, key);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
