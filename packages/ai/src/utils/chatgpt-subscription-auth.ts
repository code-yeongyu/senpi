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

/** The JWT claim holding the signed-in person's profile (email). */
const CHATGPT_SUBSCRIPTION_PROFILE_CLAIM_PATH = "https://api.openai.com/profile";

/**
 * Reads the signed-in person from a Codex access token. `chatgpt_account_id` names
 * the workspace and is shared by every member of a Team workspace, so the identity is
 * the per-member `chatgpt_account_user_id`, or the user id scoped to the workspace
 * when that claim is absent.
 */
export function extractChatGptSubscriptionIdentity(token: string): { id: string; email?: string } | undefined {
	const payload = decodePayload(token);
	const auth = claimObject(payload, CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH);
	const workspace = claimString(auth, "chatgpt_account_id");
	const user = claimString(auth, "chatgpt_user_id") ?? claimString(auth, "user_id");
	const id =
		claimString(auth, "chatgpt_account_user_id") ??
		(user !== undefined && workspace !== undefined ? `${user}/${workspace}` : undefined);
	if (id === undefined) return undefined;
	const email = claimString(claimObject(payload, CHATGPT_SUBSCRIPTION_PROFILE_CLAIM_PATH), "email");
	return email === undefined ? { id } : { id, email };
}

function decodePayload(token: string): object | undefined {
	try {
		const parts = token.split(".");
		const encodedPayload = parts.length === 3 ? parts[1] : undefined;
		if (!encodedPayload) return undefined;
		const base64 = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
		const payload: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
		return payload && typeof payload === "object" ? payload : undefined;
	} catch {
		return undefined;
	}
}

function authClaims(token: string): object | undefined {
	return claimObject(decodePayload(token), CHATGPT_SUBSCRIPTION_AUTH_CLAIM_PATH);
}

function claimObject(value: object | undefined, key: string): object | undefined {
	const claim = value === undefined ? undefined : Reflect.get(value, key);
	return claim && typeof claim === "object" ? claim : undefined;
}

function claimString(value: object | undefined, key: string): string | undefined {
	const claim = value === undefined ? undefined : Reflect.get(value, key);
	return typeof claim === "string" && claim.length > 0 ? claim : undefined;
}
