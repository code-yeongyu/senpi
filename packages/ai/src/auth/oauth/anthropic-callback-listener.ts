/**
 * Loopback callback listener for the Anthropic OAuth flow.
 *
 * The OAuth client accepts any `localhost` port on the `/callback` path (the
 * Claude Code CLI itself binds a random port per login), so the listener
 * prefers the historical port 53692 and falls back to an ephemeral port when
 * another login - in this process or in another one - still holds it. With a
 * fixed port, a second login on the same machine sent its browser redirect to
 * the OTHER process's listener, which could only answer "State mismatch".
 *
 * NOTE: Node-only (http.createServer); reached through the lazy OAuth loader.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { formatErrorDetails } from "./error-details.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

export type CallbackCode = { code: string; state: string };

export type CallbackListener = {
	/** Bound loopback port; `undefined` when no port could be bound (manual-only login). */
	port?: number;
	redirectUri: string;
	callbackUnavailable?: { code: string };
	waitForCode: () => Promise<CallbackCode | null>;
	cancelWait: () => void;
	close: () => Promise<void>;
};

export type CallbackListenerApis = {
	createServer: typeof import("node:http").createServer;
};

export const PREFERRED_CALLBACK_PORT = 53692;
export const CALLBACK_PATH = "/callback";
const BIND_FAILURE_CODES = new Set(["EACCES", "EADDRINUSE", "EPERM"]);

export function callbackRedirectUri(port: number): string {
	return `http://localhost:${port}${CALLBACK_PATH}`;
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}

/**
 * A callback whose `state` belongs to another login. Either a different
 * session's login could not bind its own port and is waiting for a pasted
 * redirect URL, or this tab belongs to an attempt that no longer exists.
 */
function foreignLoginHtml(requestUrl: string): string {
	return oauthErrorHtml(
		"This browser login belongs to a different session of this app, or to an earlier login attempt.",
		[
			"If a session is still waiting for this login (it shows a prompt to paste the redirect URL), copy the full address from the browser's address bar and paste it there.",
			"Otherwise this attempt is stale: close this tab and run the login again from the session that needs it.",
			"",
			requestUrl,
		].join("\n"),
	);
}

function handleCallback(
	req: IncomingMessage,
	res: ServerResponse,
	port: number,
	expectedState: string,
	settle: (value: CallbackCode) => void,
): void {
	try {
		const url = new URL(req.url ?? "", `http://localhost:${port}`);
		if (url.pathname !== CALLBACK_PATH) {
			respondHtml(res, 404, oauthErrorHtml("Callback route not found."));
			return;
		}
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const error = url.searchParams.get("error");
		if (error) {
			respondHtml(res, 400, oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
			return;
		}
		if (!code || !state) {
			respondHtml(res, 400, oauthErrorHtml("Missing code or state parameter."));
			return;
		}
		if (state !== expectedState) {
			respondHtml(res, 400, foreignLoginHtml(url.toString()));
			return;
		}
		respondHtml(res, 200, oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
		settle({ code, state });
	} catch {
		res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Internal error");
	}
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

function boundPort(server: Server): number | undefined {
	const address = server.address();
	return typeof address === "object" && address !== null ? address.port : undefined;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		// Keep-alive connections from the browser would otherwise delay the close
		// callback until they idle out.
		server.closeAllConnections?.();
	});
}

function bind(
	apis: CallbackListenerApis,
	port: number,
	host: string,
	expectedState: string,
	settle: (value: CallbackCode) => void,
): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = apis.createServer((req, res) => {
			handleCallback(req, res, boundPort(server) ?? port, expectedState, settle);
		});
		server.on("error", reject);
		server.listen(port, host, () => resolve(server));
	});
}

/**
 * Binds the preferred port, then an ephemeral one; when neither can be bound
 * the login continues in manual mode with the registered preferred-port
 * redirect URI, so a pasted redirect URL still exchanges.
 */
export async function startCallbackListener(
	apis: CallbackListenerApis,
	expectedState: string,
	host: string,
): Promise<CallbackListener> {
	let settled = false;
	let settle!: (value: CallbackCode | null) => void;
	const waitForCodePromise = new Promise<CallbackCode | null>((resolve) => {
		settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});
	let lastBindFailure: string | undefined;
	for (const port of [PREFERRED_CALLBACK_PORT, 0]) {
		try {
			const server = await bind(apis, port, host, expectedState, settle);
			const actualPort = boundPort(server) ?? port;
			return {
				port: actualPort,
				redirectUri: callbackRedirectUri(actualPort),
				waitForCode: () => waitForCodePromise,
				cancelWait: () => settle(null),
				close: () => closeServer(server),
			};
		} catch (error) {
			const code = errorCode(error);
			if (code === undefined || !BIND_FAILURE_CODES.has(code)) {
				throw new Error(`Could not open OAuth callback listener at ${host}:${port}: ${formatErrorDetails(error)}`);
			}
			lastBindFailure = code;
		}
	}
	return {
		redirectUri: callbackRedirectUri(PREFERRED_CALLBACK_PORT),
		callbackUnavailable: { code: lastBindFailure ?? "EADDRINUSE" },
		waitForCode: async () => null,
		cancelWait: () => {},
		close: async () => {},
	};
}
