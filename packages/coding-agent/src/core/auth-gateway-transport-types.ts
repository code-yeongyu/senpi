export type AuthGatewayTransportAuth =
	| { readonly kind: "token-file"; readonly path: string }
	| { readonly kind: "token-value"; readonly token: string };

export type AuthGatewayTls = {
	readonly certFile: string;
	readonly keyFile: string;
};

export type AuthGatewayMtlsProfile = {
	readonly certFile: string;
	readonly keyFile: string;
	readonly caFile?: string;
};

export type AuthGatewayTransportRequest = {
	readonly body: unknown | undefined;
	readonly method: string;
	readonly pathname: string;
	readonly peerAddress: string | undefined;
	readonly signal: AbortSignal;
};

export type AuthGatewayTransportResponse = {
	readonly body?: unknown;
	readonly headers?: Readonly<Record<string, string>>;
	readonly statusCode: number;
};

export type AuthGatewayTransportOptions = {
	readonly allowRemoteBind?: boolean;
	readonly allowedOrigins?: readonly string[];
	readonly auth: AuthGatewayTransportAuth;
	readonly brokerMtls?: AuthGatewayMtlsProfile;
	readonly brokerUrl?: string;
	readonly host?: string;
	readonly idleTimeoutMs?: number;
	readonly maxBodyBytes?: number;
	readonly maxConcurrentRequests?: number;
	readonly onRequest?: (request: AuthGatewayTransportRequest) => Promise<AuthGatewayTransportResponse>;
	readonly port?: number;
	readonly tls?: AuthGatewayTls;
	readonly trustedProxy?: string;
	readonly version?: string;
};

export type AuthGatewayTransportHandle = {
	readonly host: string;
	readonly port: number;
	readonly tokenFile: string | undefined;
	readonly url: string;
	close(): Promise<void>;
};

export class AuthGatewayTransportConfigError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "AuthGatewayTransportConfigError";
	}
}
