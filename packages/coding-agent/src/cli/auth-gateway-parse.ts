import type { AuthGatewayAuthorizedModel } from "../core/auth-gateway-observability.ts";

export class AuthGatewayParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthGatewayParseError";
	}
}

export function parseAuthorizedModel(value: string): AuthGatewayAuthorizedModel {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new AuthGatewayParseError("--model must use provider/model format");
	}
	return { modelId: value.slice(separator + 1), provider: value.slice(0, separator) };
}

export function parseBind(value: string): { readonly host: string; readonly port: number } {
	const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(value);
	if (match === null) {
		throw new AuthGatewayParseError("Invalid gateway bind; use 127.0.0.1:PORT, [::1]:PORT, or localhost:PORT");
	}
	const port = Number(match[2]);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new AuthGatewayParseError("Invalid gateway bind port");
	}
	const host = match[1] === "[::1]" ? "::1" : match[1];
	return { host, port };
}
