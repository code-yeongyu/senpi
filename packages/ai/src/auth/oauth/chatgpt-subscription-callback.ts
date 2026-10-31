/**
 * Loopback listener for the ChatGPT subscription browser login (senpi#3623).
 *
 * OpenAI registers only ports 1455 and 1457 for this client, so the port cannot be ephemeral. When
 * another login on this machine (a second session, an abandoned RPC prompt, the desktop engine, or
 * Codex CLI) still holds 1455, this asks it to let go with a `POST /cancel` carrying a header no web page can send (Codex CLI's server answers any method on `/cancel`) and retries briefly, then
 * falls back to 1457, the same order as Codex CLI's `bind_server`. The authorize URL must name the
 * port actually bound, so callers build it from the returned `redirectUri`.
 *
 * NOTE: uses node:http; reached only through the lazily loaded ChatGPT OAuth flow.
 */

import { request } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sleep } from "../../utils/sleep.ts";
import { OAUTH_CANCEL_HEADER, type OAuthCallbackServer, startOAuthCallbackServer } from "./callback-server.ts";

export const CHATGPT_CALLBACK_PORTS: readonly number[] = [1455, 1457];
const PORTS_ENV = "PI_CHATGPT_OAUTH_CALLBACK_PORTS";
const CALLBACK_PATH = "/auth/callback";
const CANCEL_PATH = "/cancel";
const PRIMARY_BIND_ATTEMPTS = 10;
const RETRY_DELAY_MS = 200;
const CANCEL_TIMEOUT_MS = 2_000;

export interface ChatGptCallback {
	readonly server: OAuthCallbackServer<string>;
	readonly redirectUri: string;
}

export interface ChatGptCallbackOptions {
	readonly host: string;
	readonly state: string;
	readonly signal: AbortSignal;
	readonly ports?: readonly number[];
}

function configuredPorts(): readonly number[] {
	const ports = (getProviderEnvValue(PORTS_ENV) ?? "")
		.split(",")
		.map((value) => Number.parseInt(value.trim(), 10))
		.filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
	return ports.length > 0 ? ports : CHATGPT_CALLBACK_PORTS;
}

function isAddressInUse(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function askHolderToCancel(host: string, port: number): Promise<void> {
	return new Promise((resolve) => {
		const outgoing = request(
			{
				host,
				port,
				path: CANCEL_PATH,
				method: "POST",
				headers: { [OAUTH_CANCEL_HEADER]: "1" },
				timeout: CANCEL_TIMEOUT_MS,
			},
			(response) => {
				response.resume();
				response.on("end", resolve);
				response.on("error", () => resolve());
			},
		);
		outgoing.on("timeout", () => outgoing.destroy());
		outgoing.on("error", () => resolve());
		outgoing.end();
	});
}

function listen(options: ChatGptCallbackOptions, port: number): Promise<OAuthCallbackServer<string>> {
	return startOAuthCallbackServer({
		providerName: "OpenAI",
		host: options.host,
		port,
		path: CALLBACK_PATH,
		redirectHost: "localhost",
		cancelPath: CANCEL_PATH,
		state: options.state,
		complete: async (code) => code,
		signal: options.signal,
	});
}

export async function startChatGptCallback(options: ChatGptCallbackOptions): Promise<ChatGptCallback | undefined> {
	const [primary, ...fallbacks] = options.ports ?? configuredPorts();
	if (primary === undefined) return undefined;
	for (let attempt = 0; attempt < PRIMARY_BIND_ATTEMPTS; attempt++) {
		try {
			const server = await listen(options, primary);
			return { server, redirectUri: server.redirectUri };
		} catch (error) {
			if (!isAddressInUse(error)) return undefined;
			if (attempt === 0) await askHolderToCancel(options.host, primary);
			await sleep(RETRY_DELAY_MS, options.signal);
		}
	}
	for (const port of fallbacks) {
		try {
			const server = await listen(options, port);
			return { server, redirectUri: server.redirectUri };
		} catch (error) {
			if (!isAddressInUse(error)) return undefined;
		}
	}
	return undefined;
}
