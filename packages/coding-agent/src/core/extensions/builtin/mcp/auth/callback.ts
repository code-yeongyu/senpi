import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpLogger } from "../log.ts";
import { type McpAsyncErrorSink, safeTimer } from "../wrap.ts";
import { OAuthFlowError } from "./oauth-errors.ts";

export interface CallbackServerOptions {
	serverName: string;
	// Fixed port required for pre-registered clients; omit for an OS-assigned
	// port (used with DCR/CIMD dynamic redirect registration).
	port?: number;
	host?: string;
	path?: string;
	timeoutMs?: number;
	logger?: McpLogger;
	// Single-use CSRF check. Returning false yields a 400 and does NOT complete.
	validateState: (state: string | undefined) => boolean;
}

export interface CallbackResult {
	code: string;
	state: string | undefined;
}

export interface CallbackChannel {
	redirectUrl: string;
	usesLoopback: boolean;
	waitForCode: () => Promise<CallbackResult>;
	close: () => Promise<void>;
}

// Chooses the redirect channel for an authorization: a real loopback listener,
// or — when `mcp.oauthCallbackUrl` is configured — a paste channel with ZERO
// local listeners (completion arrives via /mcp auth-complete).
export async function openCallbackChannel(
	options: CallbackServerOptions & { overrideUrl?: string },
): Promise<CallbackChannel> {
	if (options.overrideUrl !== undefined && options.overrideUrl.length > 0) {
		return {
			redirectUrl: options.overrideUrl,
			usesLoopback: false,
			waitForCode: () =>
				Promise.reject(
					new OAuthFlowError(
						"headless",
						`MCP server ${options.serverName} uses a callback URL override; complete with /mcp auth-complete <redirect-url>.`,
						{ serverName: options.serverName },
					),
				),
			close: () => Promise.resolve(),
		};
	}
	const server = new LoopbackCallbackServer(options);
	const redirectUrl = await server.start();
	return {
		redirectUrl,
		usesLoopback: true,
		waitForCode: () => server.waitForCode(),
		close: () => server.close(),
	};
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SUCCESS_HTML = "<!doctype html><title>senpi</title><p>Authorization complete. You can close this tab.</p>";
const FAILURE_HTML = "<!doctype html><title>senpi</title><p>Authorization failed. Return to senpi and retry.</p>";

// Lazily-bound 127.0.0.1 listener that exists only for the duration of one
// OAuth authorization. The handle is unref'd so it never keeps the process
// alive, and it tears down on success, invalid state, or a 5-minute timeout.
export class LoopbackCallbackServer {
	readonly #options: CallbackServerOptions;
	#server: Server | undefined;
	#redirectUrl: string | undefined;
	#result: Promise<CallbackResult> | undefined;
	#resolve: ((result: CallbackResult) => void) | undefined;
	#reject: ((error: Error) => void) | undefined;
	#timer: NodeJS.Timeout | undefined;
	#settled = false;

	constructor(options: CallbackServerOptions) {
		this.#options = options;
	}

	get redirectUrl(): string | undefined {
		return this.#redirectUrl;
	}

	get #sink(): McpAsyncErrorSink {
		const logger = this.#options.logger;
		return { logger: { error: (message, data) => logger?.error(message, data) } };
	}

	async start(): Promise<string> {
		const host = this.#options.host ?? "127.0.0.1";
		const path = this.#options.path ?? "/callback";
		const server = createServer((req, res) => this.#handle(req, res, path));
		server.unref();
		this.#server = server;
		await this.#listen(server, host, this.#options.port ?? 0);
		const address = server.address() as AddressInfo;
		this.#redirectUrl = `http://${host}:${address.port}${path}`;
		this.#result = new Promise<CallbackResult>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		this.#timer = safeTimer(
			"auth.callback.timeout",
			this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			() =>
				this.#fail(
					new OAuthFlowError(
						"needs_auth",
						`MCP server ${this.#options.serverName} authorization timed out after 5 minutes.`,
						{ serverName: this.#options.serverName },
					),
				),
			this.#sink,
		);
		return this.#redirectUrl;
	}

	waitForCode(): Promise<CallbackResult> {
		if (this.#result === undefined) throw new Error("callback server not started");
		return this.#result;
	}

	async close(): Promise<void> {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		const server = this.#server;
		this.#server = undefined;
		if (server === undefined) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	#listen(server: Server, host: string, port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException): void => {
				const detail =
					error.code === "EADDRINUSE"
						? `port ${port} is already in use (another senpi auth flow may be running); free it or configure a different callback.`
						: error.message;
				reject(
					new OAuthFlowError(
						"needs_auth",
						`MCP server ${this.#options.serverName} callback listener failed: ${detail}`,
						{
							cause: error,
							serverName: this.#options.serverName,
						},
					),
				);
			};
			server.once("error", onError);
			server.listen(port, host, () => {
				server.removeListener("error", onError);
				resolve();
			});
		});
	}

	#handle(req: IncomingMessage, res: ServerResponse, path: string): void {
		const url = new URL(req.url ?? "/", this.#redirectUrl);
		if (url.pathname !== path) {
			res.writeHead(404).end();
			return;
		}
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error");
		if (error !== null || code === null || state === undefined || !this.#options.validateState(state)) {
			res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_HTML);
			void this.#fail(
				new OAuthFlowError(
					"state_mismatch",
					`MCP server ${this.#options.serverName} authorization state did not match (possible CSRF or a stale/replayed link); restart the auth flow.`,
					{ serverName: this.#options.serverName },
				),
			);
			return;
		}
		res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_HTML);
		this.#succeed({ code, state });
	}

	#succeed(result: CallbackResult): void {
		if (this.#settled) return;
		this.#settled = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#resolve?.(result);
		void this.close();
	}

	async #fail(error: Error): Promise<void> {
		if (this.#settled) return;
		this.#settled = true;
		this.#reject?.(error);
		await this.close();
	}
}
