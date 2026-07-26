/** The JWT claim holding the ChatGPT account that owns a Codex credential. */
export const OPENAI_CODEX_AUTH_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Reads the stable ChatGPT account identifier from a Codex access token.
 *
 * This deliberately uses only browser primitives so request code and OAuth
 * code can share it without pulling Node-only authentication modules into
 * browser consumers.
 */
export function extractOpenAiCodexAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		const encodedPayload = parts.length === 3 ? parts[1] : undefined;
		if (!encodedPayload) return undefined;
		const base64 = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
		const payload: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
		if (!payload || typeof payload !== "object") return undefined;
		const auth = Reflect.get(payload, OPENAI_CODEX_AUTH_CLAIM_PATH);
		if (!auth || typeof auth !== "object") return undefined;
		const accountId = Reflect.get(auth, "chatgpt_account_id");
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}
