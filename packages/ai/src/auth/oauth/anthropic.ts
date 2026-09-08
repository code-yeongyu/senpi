/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import {
	type CallbackListenerApis,
	PREFERRED_CALLBACK_PORT,
	startCallbackListener,
} from "./anthropic-callback-listener.ts";
import { parseAuthorizationInput } from "./authorization-input.ts";
import { formatErrorDetails } from "./error-details.ts";
import { generatePKCE } from "./pkce.ts";

export function __setAnthropicOAuthNodeApisForTests(apis: NodeApis | null): void {
	nodeApis = apis;
	nodeApisPromise = null;
}

type NodeApis = CallbackListenerApis;

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
/**
 * A login nobody finishes must not keep its listener (and its manual prompt)
 * alive forever: the stale listener would answer a later login's browser
 * redirect on this machine with "State mismatch".
 */
const LOGIN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

async function postJson(url: string, body: Record<string, string | number>, signal: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const listener = await startCallbackListener(await getNodeApis(), verifier, CALLBACK_HOST);
	const manualAbort = new AbortController();
	let timedOut = false;
	// Cancelling the login must release BOTH waits: the callback listener and the
	// manual prompt. In manual-only mode (no callback port could be bound) the
	// prompt is the only thing keeping the login alive, so leaving it open would
	// hang cleanup.
	const releaseWaits = () => {
		listener.cancelWait();
		manualAbort.abort();
	};
	interaction.signal.addEventListener("abort", releaseWaits, { once: true });
	if (interaction.signal.aborted) releaseWaits();
	const idleTimer = setTimeout(() => {
		timedOut = true;
		releaseWaits();
	}, LOGIN_IDLE_TIMEOUT_MS);
	idleTimer.unref?.();
	let code: string | undefined;
	let state: string | undefined;
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: listener.redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions: listener.callbackUnavailable
				? `No local OAuth callback port could be opened (port ${PREFERRED_CALLBACK_PORT} and an ephemeral port both failed: ${listener.callbackUnavailable.code}). Complete login in your browser, then copy the final redirect URL from the address bar and paste it here.`
				: "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
				placeholder: listener.redirectUri,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualInput = input;
				listener.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				listener.cancelWait();
			});

		const result = await listener.waitForCode();
		if (timedOut) throw new Error(loginTimedOutMessage());
		if (manualError) throw manualError;
		if (result?.code) {
			code = result.code;
			state = result.state;
		} else if (manualInput) {
			const parsed = parseAuthorizationInput(manualInput);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) {
			await manualPromise;
			if (timedOut) throw new Error(loginTimedOutMessage());
			if (manualError) throw manualError;
			if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
				code = parsed.code;
				state = parsed.state ?? verifier;
			}
		}

		if (!code) throw new Error("Missing authorization code");
		if (!state) throw new Error("Missing OAuth state");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, state, verifier, listener.redirectUri, interaction.signal);
	} finally {
		clearTimeout(idleTimer);
		interaction.signal.removeEventListener("abort", releaseWaits);
		manualAbort.abort();
		await listener.close();
	}
}

function loginTimedOutMessage(): string {
	const minutes = Math.round(LOGIN_IDLE_TIMEOUT_MS / 60_000);
	return `Anthropic login timed out after ${minutes} minutes without a browser callback or a pasted redirect URL. Run the login again.`;
}

/**
 * Refresh Anthropic OAuth token
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			signal,
		);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		type: "oauth",
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,
	login: loginAnthropic,
	refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
