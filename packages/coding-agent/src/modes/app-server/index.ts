import { isIP } from "node:net";
import { APP_NAME } from "../../config.ts";

export type AppServerDaemonVerb = "start" | "stop" | "status" | "restart";

export type AppServerListen =
	| { readonly kind: "stdio"; readonly url: "stdio://" }
	| { readonly kind: "unix"; readonly url: string; readonly path?: string }
	| { readonly kind: "ws"; readonly url: string; readonly host: string; readonly port: number };

export type AppServerWsAuth = { readonly kind: "off" } | { readonly kind: "token-file"; readonly path: string };

export interface AppServerModeOptions {
	readonly kind: "server";
	readonly listen: AppServerListen;
	readonly wsAuth?: AppServerWsAuth;
	readonly jsonLogs: boolean;
}

export interface AppServerDaemonCommandOptions {
	readonly kind: "daemon";
	readonly verb: AppServerDaemonVerb;
	readonly listen: AppServerListen;
}

export interface AppServerUsageError {
	readonly kind: "usage-error";
	readonly message: string;
}

export type AppServerCliArgs = AppServerModeOptions | AppServerDaemonCommandOptions | AppServerUsageError;

export const APP_SERVER_LISTEN_USAGE =
	"Invalid --listen value. Use stdio://, unix://, unix:///abs/path, or ws://IP:PORT.";

export function formatAppServerUsage(): string {
	const listenForms = "stdio://|unix://|unix:///abs/path|ws://IP:PORT";
	return [
		`Usage: ${APP_NAME} app-server [--listen <${listenForms}>] [--ws-auth <token-file|off>] [--json-logs]`,
		`       ${APP_NAME} app-server daemon <start|stop|status|restart> [--listen <${listenForms}>]`,
	].join("\n");
}

function parseListen(value: string): AppServerListen | undefined {
	if (value === "stdio://") {
		return { kind: "stdio", url: "stdio://" };
	}

	if (value === "unix://") {
		return { kind: "unix", url: "unix://" };
	}

	if (value.startsWith("unix:///")) {
		const path = value.slice("unix://".length);
		if (path.startsWith("/")) {
			return { kind: "unix", url: value, path };
		}
		return undefined;
	}

	if (!value.startsWith("ws://")) {
		return undefined;
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			return undefined;
		}
		throw error;
	}

	const port = Number(parsed.port);
	if (
		parsed.protocol !== "ws:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.port === "" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		isIP(parsed.hostname) === 0
	) {
		return undefined;
	}

	return { kind: "ws", url: value, host: parsed.hostname, port };
}

function parseDaemonVerb(value: string | undefined): AppServerDaemonVerb | undefined {
	switch (value) {
		case "start":
		case "stop":
		case "status":
		case "restart":
			return value;
		default:
			return undefined;
	}
}

function parseWsAuth(value: string): AppServerWsAuth {
	return value === "off" ? { kind: "off" } : { kind: "token-file", path: value };
}

function parseServerArgs(args: readonly string[]): AppServerModeOptions | AppServerUsageError {
	let listen: AppServerListen = { kind: "stdio", url: "stdio://" };
	let wsAuth: AppServerWsAuth | undefined;
	let jsonLogs = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--listen") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			const parsed = parseListen(value);
			if (parsed === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			listen = parsed;
			index++;
			continue;
		}
		if (arg === "--ws-auth") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: "--ws-auth requires <token-file|off>." };
			}
			wsAuth = parseWsAuth(value);
			index++;
			continue;
		}
		if (arg === "--json-logs") {
			jsonLogs = true;
			continue;
		}
		return { kind: "usage-error", message: `Unexpected app-server argument: ${arg}` };
	}

	return { kind: "server", listen, wsAuth, jsonLogs };
}

function parseDaemonArgs(args: readonly string[]): AppServerDaemonCommandOptions | AppServerUsageError {
	const verb = parseDaemonVerb(args[0]);
	if (verb === undefined) {
		return { kind: "usage-error", message: "Usage: app-server daemon <start|stop|status|restart>." };
	}

	let listen: AppServerListen = { kind: "ws", url: "ws://127.0.0.1:18800", host: "127.0.0.1", port: 18800 };
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--listen") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			const parsed = parseListen(value);
			if (parsed === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			listen = parsed;
			index++;
			continue;
		}
		return { kind: "usage-error", message: `Unexpected app-server daemon argument: ${arg}` };
	}

	return { kind: "daemon", verb, listen };
}

export function parseAppServerCliArgs(args: readonly string[]): AppServerCliArgs {
	if (args[0] === "daemon") {
		return parseDaemonArgs(args.slice(1));
	}
	return parseServerArgs(args);
}

export async function runAppServerMode(_options: AppServerModeOptions): Promise<never> {
	console.error("app-server mode scaffolding — not yet wired");
	process.exit(3);
}

export async function runAppServerDaemonCommand(_options: AppServerDaemonCommandOptions): Promise<never> {
	console.error("app-server mode scaffolding — not yet wired");
	process.exit(3);
}
