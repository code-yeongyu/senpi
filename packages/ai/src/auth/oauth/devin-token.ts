/**
 * Devin (Cognition) CLI token exchange.
 *
 * Devin's CLI grant is deliberately non-standard: the authorization code is
 * redeemed with a bare JSON body carrying only the code and the PKCE verifier
 * (no client_id, no grant_type), and the response returns ONE opaque JWT in
 * "token" that serves as both the access and the refresh credential. Expiry is
 * read from the JWT itself because the response carries no expires_in.
 */

import type { OAuthCredential } from "../types.ts";

export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
export const DEVIN_API_ENDPOINT = "https://api.devin.ai";

/** Devin issues long-lived CLI tokens; used when the JWT carries no usable exp. */
export const DEVIN_FALLBACK_EXPIRY_MS = 31_536_000_000;

const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

function decodeJwtExpiry(token: string): number | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
	try {
		const parsed = JSON.parse(atob(padded)) as JsonObject;
		const exp = parsed.exp;
		if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return Math.trunc(exp * 1000);
	} catch {
		// A token whose payload is not readable JSON falls back to the fixed window.
	}
	return undefined;
}

function errorDetail(body: JsonObject): string | undefined {
	if (typeof body.error_description === "string") return body.error_description;
	if (typeof body.message === "string") return body.message;
	if (typeof body.error === "string") return body.error;
	if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
		const message = (body.error as JsonObject).message;
		if (typeof message === "string") return message;
	}
	return undefined;
}

/** Builds the credential Devin's CLI stores: one token for access and refresh. */
export function devinCredential(token: string): OAuthCredential {
	return {
		type: "oauth",
		access: token,
		refresh: token,
		expires: decodeJwtExpiry(token) ?? Date.now() + DEVIN_FALLBACK_EXPIRY_MS,
	};
}

export async function exchangeDevinAuthorizationCode(
	code: string,
	verifier: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (signal.aborted) throw new Error("Login cancelled");
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error("Devin OAuth token exchange timed out")),
		TOKEN_EXCHANGE_TIMEOUT_MS,
	);

	let response: Response;
	let body: JsonObject = {};
	try {
		response = await fetch(DEVIN_TOKEN_URL, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier }),
			signal: controller.signal,
		});
		try {
			const parsed = (await response.json()) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
		} catch {
			if (response.ok) throw new Error("Devin OAuth returned invalid JSON");
		}
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled");
		if (controller.signal.aborted) throw new Error("Devin OAuth token exchange timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}

	if (!response.ok) {
		const detail = errorDetail(body);
		throw new Error(`Devin OAuth token exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
	}

	if (typeof body.token !== "string" || body.token.length === 0) {
		throw new Error('Devin OAuth response carries no "token"');
	}

	return devinCredential(body.token);
}
