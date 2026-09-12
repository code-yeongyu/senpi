/**
 * Devin CLI OAuth loopback callback.
 *
 * Devin registers ONE redirect URI for the CLI, so the callback binds the fixed
 * loopback port 59653 instead of an ephemeral one: a different port is rejected
 * by the authorize page. The server is one-shot, validates the issued state
 * before spending the code, and renders the shared OAuth result pages.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthCredential } from "../types.ts";
import { exchangeDevinAuthorizationCode } from "./devin-token.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

export const DEVIN_CALLBACK_PORT = 59653;
export const DEVIN_CALLBACK_PATH = "/callback";

export type DevinCallbackServer = {
	callbackUrl: string;
	close: () => void;
	/** Hand the login to manual code entry unless a callback already claimed it. */
	cancelWait: () => void;
	waitForCredential: () => Promise<OAuthCredential | null>;
};

function callbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
	response.statusCode = status;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(html);
}

export async function startDevinCallbackServer(input: {
	state: string;
	verifier: string;
	signal: AbortSignal;
	loginTimeoutMs: number;
}): Promise<DevinCallbackServer> {
	if (input.signal.aborted) throw new Error("Login cancelled");
	const host = callbackHost();
	let resolveCredential: (credential: OAuthCredential | null) => void = () => {};
	let rejectCredential: (error: Error) => void = () => {};
	const credential = new Promise<OAuthCredential | null>((resolve, reject) => {
		resolveCredential = resolve;
		rejectCredential = reject;
	});

	let claimed = false;
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	const close = (): void => {
		if (timeout) clearTimeout(timeout);
		if (onAbort) input.signal.removeEventListener("abort", onAbort);
		server.close();
	};

	const finish = (result: { credential: OAuthCredential | null } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		close();
		if ("credential" in result) resolveCredential(result.credential);
		else rejectCredential(result.error);
	};

	const server: Server = createServer((request, response) => {
		void (async () => {
			const requestUrl = new URL(request.url ?? "/", `http://${host}`);
			if (request.method !== "GET" || requestUrl.pathname !== DEVIN_CALLBACK_PATH) {
				sendHtml(response, 404, oauthErrorHtml("OAuth callback route not found."));
				return;
			}
			if (claimed || settled) {
				sendHtml(response, 409, oauthErrorHtml("This OAuth callback has already been used."));
				return;
			}

			const oauthError = requestUrl.searchParams.get("error");
			if (oauthError) {
				const description = requestUrl.searchParams.get("error_description") ?? oauthError;
				sendHtml(response, 400, oauthErrorHtml("Devin authorization was denied.", description));
				finish({ error: new Error(`Devin authorization failed: ${description}`) });
				return;
			}

			// The state guard runs before the code is spent: a forged callback must
			// never reach the token endpoint.
			const state = requestUrl.searchParams.get("state") ?? "";
			if (state !== input.state) {
				sendHtml(response, 400, oauthErrorHtml("Devin authorization state mismatch."));
				finish({ error: new Error("Devin OAuth callback state mismatch") });
				return;
			}

			const code = requestUrl.searchParams.get("code");
			if (!code) {
				sendHtml(response, 400, oauthErrorHtml("Devin returned no authorization code."));
				return;
			}
			claimed = true;

			try {
				const result = await exchangeDevinAuthorizationCode(code, input.verifier, input.signal);
				sendHtml(response, 200, oauthSuccessHtml("Signed in to Devin. You may now close this page."));
				finish({ credential: result });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown token exchange error";
				sendHtml(response, 502, oauthErrorHtml("Devin token exchange failed.", message));
				finish({ error: error instanceof Error ? error : new Error(message) });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(DEVIN_CALLBACK_PORT, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	server.on("error", (error) => finish({ error }));
	onAbort = () => finish({ error: new Error("Login cancelled") });
	input.signal.addEventListener("abort", onAbort, { once: true });
	if (input.signal.aborted) {
		close();
		throw new Error("Login cancelled");
	}
	timeout = setTimeout(() => finish({ error: new Error("Devin OAuth login timed out") }), input.loginTimeoutMs);

	return {
		callbackUrl: `http://${host}:${DEVIN_CALLBACK_PORT}${DEVIN_CALLBACK_PATH}`,
		close,
		cancelWait: () => {
			if (!claimed) finish({ credential: null });
		},
		waitForCredential: () => credential,
	};
}
