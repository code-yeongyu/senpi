import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type {
	AuthGatewayMtlsProfile,
	AuthGatewayTls,
	AuthGatewayTransportAuth,
	AuthGatewayTransportOptions,
} from "./auth-gateway-transport-types.ts";
import { AuthGatewayTransportConfigError } from "./auth-gateway-transport-types.ts";

export type ResolvedGatewayAuth = { readonly path: string | undefined; readonly token: string };

export function parseAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
	const parsed = new Set<string>();
	for (const value of origins) {
		let origin: URL;
		try {
			origin = new URL(value);
		} catch {
			throw new AuthGatewayTransportConfigError("Gateway allowed origins must be absolute origins.");
		}
		if (origin.origin !== value || (origin.protocol !== "http:" && origin.protocol !== "https:")) {
			throw new AuthGatewayTransportConfigError("Gateway allowed origins must be exact HTTP origins.");
		}
		parsed.add(value);
	}
	return parsed;
}

export function validateTransportOptions(
	options: AuthGatewayTransportOptions & { readonly host: string; readonly port: number },
): void {
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new AuthGatewayTransportConfigError("Auth gateway port must be an integer between 0 and 65535.");
	}
	if (!isLoopbackHost(options.host) && (options.allowRemoteBind !== true || options.tls === undefined)) {
		throw new AuthGatewayTransportConfigError(
			"Refusing non-loopback auth gateway bind without explicit TLS remote-bind configuration.",
		);
	}
	if (options.maxBodyBytes !== undefined && (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)) {
		throw new AuthGatewayTransportConfigError("Auth gateway body limit must be a positive integer.");
	}
	if (
		options.maxConcurrentRequests !== undefined &&
		(!Number.isInteger(options.maxConcurrentRequests) || options.maxConcurrentRequests < 1)
	) {
		throw new AuthGatewayTransportConfigError("Auth gateway concurrency limit must be a positive integer.");
	}
	if (options.idleTimeoutMs !== undefined && (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1)) {
		throw new AuthGatewayTransportConfigError("Auth gateway idle timeout must be a positive integer.");
	}
	if (options.brokerUrl !== undefined) validateBrokerUrl(options.brokerUrl, options.brokerMtls);
	if (options.brokerMtls !== undefined && options.brokerUrl === undefined) {
		throw new AuthGatewayTransportConfigError("Broker mTLS requires a broker URL.");
	}
	if (options.trustedProxy !== undefined && !isIpAddress(options.trustedProxy)) {
		throw new AuthGatewayTransportConfigError("Trusted proxy must be a literal IP address.");
	}
}

const MIN_GATEWAY_BEARER_LENGTH = 32;

export async function resolveGatewayAuth(auth: AuthGatewayTransportAuth): Promise<ResolvedGatewayAuth> {
	if (auth.kind === "token-value") {
		assertBearerStrength(auth.token, "Auth gateway bearer token");
		return { path: undefined, token: auth.token };
	}
	await mkdir(dirname(auth.path), { mode: 0o700, recursive: true });
	await chmod(dirname(auth.path), 0o700);
	try {
		const token = (await readFile(auth.path, "utf8")).trim();
		assertBearerStrength(token, "Auth gateway token file");
		await chmod(auth.path, 0o600);
		return { path: auth.path, token };
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
	}
	const token = randomBytes(32).toString("hex");
	try {
		await writeFile(auth.path, `${token}\n`, { flag: "wx", mode: 0o600 });
		return { path: auth.path, token };
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "EEXIST")) throw error;
		const existing = (await readFile(auth.path, "utf8")).trim();
		assertBearerStrength(existing, "Auth gateway token file");
		await chmod(auth.path, 0o600);
		return { path: auth.path, token: existing };
	}
}

function assertBearerStrength(token: string, label: string): void {
	if (token.length === 0) {
		throw new AuthGatewayTransportConfigError(`${label} must not be empty.`);
	}
	if (token.length < MIN_GATEWAY_BEARER_LENGTH) {
		throw new AuthGatewayTransportConfigError(`${label} must be at least ${MIN_GATEWAY_BEARER_LENGTH} characters.`);
	}
}

export async function loadTls(tls: AuthGatewayTls): Promise<{ readonly cert: Buffer; readonly key: Buffer }> {
	if (tls.certFile.length === 0 || tls.keyFile.length === 0) {
		throw new AuthGatewayTransportConfigError("Gateway TLS requires certificate and key files.");
	}
	return { cert: await readFile(tls.certFile), key: await readFile(tls.keyFile) };
}

export function hostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function validateBrokerUrl(value: string, mtls: AuthGatewayMtlsProfile | undefined): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AuthGatewayTransportConfigError("Broker URL must be absolute.");
	}
	if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
		throw new AuthGatewayTransportConfigError("Refusing insecure non-loopback broker URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new AuthGatewayTransportConfigError("Broker URL must use HTTP or HTTPS.");
	}
	if (mtls !== undefined) {
		if (url.protocol !== "https:")
			throw new AuthGatewayTransportConfigError("Broker mTLS requires an HTTPS broker URL.");
		if (mtls.certFile.length === 0 || mtls.keyFile.length === 0) {
			throw new AuthGatewayTransportConfigError("Broker mTLS requires certificate and key files.");
		}
	}
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	return (
		normalized === "localhost" || normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."))
	);
}

function isIpAddress(value: string): boolean {
	const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
	return isIP(normalized) !== 0;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
