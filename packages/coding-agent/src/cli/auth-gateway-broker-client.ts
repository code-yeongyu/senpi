import { join } from "node:path";
import { AuthBrokerRemoteStore } from "../core/auth-broker-remote-store.ts";
import { parseAuthBrokerWireResponse } from "../core/auth-broker-wire-contract.ts";
import { readToken } from "./auth-gateway-token.ts";

const BROKER_TOKEN_FILE = "auth-broker.token";

export type AuthGatewayBrokerOptions = {
	readonly brokerToken?: string;
	readonly brokerUrl?: string;
};

export type AuthGatewayBrokerConfig = {
	readonly token: string;
	readonly url: string;
};

export class AuthGatewayBrokerConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthGatewayBrokerConfigError";
	}
}

/** Reject non-loopback http broker URLs before any bearer token is sent. */
export function assertBrokerUrlAllowed(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AuthGatewayBrokerConfigError(`Invalid SENPI_AUTH_BROKER_URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new AuthGatewayBrokerConfigError(`SENPI_AUTH_BROKER_URL must be http(s): ${url}`);
	}
	const host = parsed.hostname.toLowerCase();
	const loopback =
		host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
	if (parsed.protocol === "http:" && !loopback) {
		throw new AuthGatewayBrokerConfigError(
			`SENPI_AUTH_BROKER_URL must be loopback for http (got ${host}); use https for remote brokers`,
		);
	}
}

export async function brokerConfig(
	options: AuthGatewayBrokerOptions,
	agentDir: string,
	required: boolean,
): Promise<AuthGatewayBrokerConfig | undefined> {
	const url = options.brokerUrl ?? process.env.SENPI_AUTH_BROKER_URL;
	if (url === undefined || url.length === 0) {
		if (!required) return undefined;
		throw new AuthGatewayBrokerConfigError(
			"auth-gateway requires broker authentication: set SENPI_AUTH_BROKER_URL and SENPI_AUTH_BROKER_TOKEN",
		);
	}
	assertBrokerUrlAllowed(url);
	const token =
		options.brokerToken ??
		process.env.SENPI_AUTH_BROKER_TOKEN ??
		(await readToken(join(agentDir, BROKER_TOKEN_FILE)));
	if (token === undefined) {
		throw new AuthGatewayBrokerConfigError(
			"auth-gateway requires broker authentication: set SENPI_AUTH_BROKER_TOKEN or auth-broker.token",
		);
	}
	return { token, url };
}

export async function requiredBrokerConfig(
	options: AuthGatewayBrokerOptions,
	agentDir: string,
): Promise<AuthGatewayBrokerConfig> {
	const broker = await brokerConfig(options, agentDir, true);
	if (broker === undefined) throw new AuthGatewayBrokerConfigError("auth-gateway requires broker authentication");
	return broker;
}

export function brokerStore(broker: AuthGatewayBrokerConfig): AuthBrokerRemoteStore {
	// URL already validated in brokerConfig before token is read/returned.
	return new AuthBrokerRemoteStore({
		async request(request: unknown) {
			const response = await fetch(new URL("/v1/broker", broker.url), {
				body: JSON.stringify(request),
				headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
				method: "POST",
			});
			if (response.status === 401 || response.status === 403) {
				throw new AuthGatewayBrokerConfigError("Broker authentication failed.");
			}
			if (!response.ok) throw new AuthGatewayBrokerConfigError("Broker snapshot request failed.");
			return parseAuthBrokerWireResponse(await response.json());
		},
	});
}
