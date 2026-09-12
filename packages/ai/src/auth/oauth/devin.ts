/**
 * Devin (Cognition) CLI OAuth flow.
 *
 * Mirrors the Devin CLI login: the authorize page at app.devin.ai redeems a
 * PKCE S256 challenge against the fixed loopback redirect, and the resulting
 * code is exchanged for a single long-lived CLI token. There is no refresh
 * grant - Devin re-issues the token through a fresh login - so refresh returns
 * the stored credential untouched.
 *
 * api.devin.ai is the LOGIN host only. The token it mints is spent against the
 * Cascade model host seeded on every Devin model, so toAuth must never return a
 * baseUrl: the registry would overlay it onto the model and every chat would
 * 404 on the REST API.
 *
 * NOTE: the callback module uses node:http and is CLI-only, never browser.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startDevinCallbackServer } from "./devin-callback.ts";
import { exchangeDevinAuthorizationCode } from "./devin-token.ts";
import { generatePKCE } from "./pkce.ts";

const AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function parseAuthorizationInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	try {
		return new URL(value).searchParams.get("code") ?? undefined;
	} catch {
		// not a URL
	}
	if (value.includes("code=")) return new URLSearchParams(value).get("code") ?? undefined;
	return value;
}

function authorizeUrl(input: { redirectUri: string; challenge: string; state: string }): string {
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		redirect_uri: input.redirectUri,
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		state: input.state,
		prompt: "select_account",
	}).toString();
	return url.toString();
}

async function loginDevin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const callback = await startDevinCallbackServer({
		state,
		verifier,
		signal: interaction.signal,
		loginTimeoutMs: LOGIN_TIMEOUT_MS,
	});
	const manualAbort = new AbortController();
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		interaction.notify({
			type: "progress",
			message: `Listening for the Devin OAuth callback on ${callback.callbackUrl}`,
		});
		interaction.notify({
			type: "auth_url",
			url: authorizeUrl({ redirectUri: callback.callbackUrl, challenge, state }),
			instructions:
				"Sign in to Devin in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
				placeholder: callback.callbackUrl,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualInput = input;
				callback.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				callback.cancelWait();
			});

		const credential = await callback.waitForCredential();
		if (manualError) throw manualError;
		if (credential) return credential;

		await manualPromise;
		if (manualError) throw manualError;
		const code = manualInput ? parseAuthorizationInput(manualInput) : undefined;
		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging the authorization code for a Devin token..." });
		return await exchangeDevinAuthorizationCode(code, verifier, interaction.signal);
	} finally {
		manualAbort.abort();
		callback.close();
	}
}

export const devinOAuth: OAuthAuth = {
	name: "Devin",
	isSubscription: true,
	loginLabel: "Sign in with Devin",
	login: loginDevin,
	async refresh(credential, _signal) {
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
