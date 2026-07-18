import type { AuthBrokerRemoteStore } from "./auth-broker-remote-store.ts";
import type { AuthBrokerCredentialMetadata, AuthBrokerMetadataSnapshot } from "./auth-broker-wire-contract.ts";
import type { AuthGatewayTransportRequest, AuthGatewayTransportResponse } from "./auth-gateway-transport.ts";

export type AuthGatewayAuthorizedModel = {
	readonly modelId: string;
	readonly provider: string;
};

type CredentialStatus = "available" | "configured" | "disabled" | "unavailable";

type CredentialDiagnostic = {
	readonly credentialId: string;
	readonly provider: string;
	readonly status: CredentialStatus;
	readonly type: "api_key" | "oauth";
};

export type AuthGatewayObservabilityOptions = {
	readonly broker: AuthBrokerRemoteStore;
	readonly checkCredential?: (credential: AuthBrokerCredentialMetadata) => Promise<"available">;
	readonly models: readonly AuthGatewayAuthorizedModel[];
	readonly usageCacheTtlMs?: number;
};

export type AuthGatewayObservabilityHandler = (
	request: AuthGatewayTransportRequest,
) => Promise<AuthGatewayTransportResponse>;

const DEFAULT_USAGE_CACHE_TTL_MS = 5_000;

export function createAuthGatewayObservabilityHandler(
	options: AuthGatewayObservabilityOptions,
): AuthGatewayObservabilityHandler {
	const handler = new GatewayObservabilityHandler(options);
	return async (request) => handler.handle(request);
}

class GatewayObservabilityHandler {
	private readonly broker: AuthBrokerRemoteStore;
	private readonly checkCredential: ((credential: AuthBrokerCredentialMetadata) => Promise<"available">) | undefined;
	private readonly models: readonly AuthGatewayAuthorizedModel[];
	private readonly usageCacheTtlMs: number;
	private usageCache: { readonly data: readonly CredentialDiagnostic[]; readonly validUntil: number } | undefined;
	private usageFlight: Promise<readonly CredentialDiagnostic[]> | undefined;

	constructor(options: AuthGatewayObservabilityOptions) {
		if (
			!Number.isInteger(options.usageCacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS) ||
			(options.usageCacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS) < 1
		) {
			throw new AuthGatewayObservabilityError("Usage cache TTL must be a positive integer.");
		}
		this.broker = options.broker;
		this.checkCredential = options.checkCredential;
		this.models = options.models;
		this.usageCacheTtlMs = options.usageCacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS;
	}

	async handle(request: AuthGatewayTransportRequest): Promise<AuthGatewayTransportResponse> {
		try {
			switch (request.pathname) {
				case "/v1/models":
					return { body: { data: this.modelsFor(await this.snapshot()), object: "list" }, statusCode: 200 };
				case "/v1/usage":
					return { body: { data: await this.usage(), object: "list" }, statusCode: 200 };
				case "/v1/credentials/check":
					return { body: { data: await this.check(), object: "list" }, statusCode: 200 };
				default:
					return { body: { error: "route adapter unavailable" }, statusCode: 501 };
			}
		} catch {
			return { body: { error: "broker unavailable" }, statusCode: 503 };
		}
	}

	private async snapshot(): Promise<AuthBrokerMetadataSnapshot> {
		return this.broker.metadataSnapshot({ forceRefresh: true });
	}

	private modelsFor(
		snapshot: AuthBrokerMetadataSnapshot,
	): readonly { readonly id: string; readonly object: "model"; readonly owned_by: string }[] {
		const activeProviders = new Set(
			snapshot.credentials
				.filter((credential) => credential.disabled === undefined)
				.map((credential) => credential.pool.provider),
		);
		const models: { id: string; object: "model"; owned_by: string }[] = [];
		const seen = new Set<string>();
		for (const model of this.models) {
			const key = `${model.provider}/${model.modelId}`;
			if (activeProviders.has(model.provider) && !seen.has(key)) {
				models.push({ id: `${model.provider}/${model.modelId}`, object: "model", owned_by: model.provider });
				seen.add(key);
			}
		}
		return models;
	}

	private async usage(): Promise<readonly CredentialDiagnostic[]> {
		if (this.usageCache !== undefined && this.usageCache.validUntil > Date.now()) return this.usageCache.data;
		const existing = this.usageFlight;
		if (existing !== undefined) return existing;
		const flight = this.snapshot().then((snapshot) => snapshot.credentials.map(diagnosticFor));
		this.usageFlight = flight;
		try {
			const data = await flight;
			this.usageCache = { data, validUntil: Date.now() + this.usageCacheTtlMs };
			return data;
		} finally {
			if (this.usageFlight === flight) this.usageFlight = undefined;
		}
	}

	private async check(): Promise<readonly CredentialDiagnostic[]> {
		const snapshot = await this.snapshot();
		return Promise.all(snapshot.credentials.map(async (credential) => this.checkOne(credential)));
	}

	private async checkOne(credential: AuthBrokerCredentialMetadata): Promise<CredentialDiagnostic> {
		if (credential.disabled !== undefined) return diagnosticFor(credential);
		if (this.checkCredential === undefined) {
			return {
				credentialId: credential.credentialId,
				provider: credential.pool.provider,
				status: "configured",
				type: credential.pool.type,
			};
		}
		try {
			await this.checkCredential(credential);
			return diagnosticFor(credential);
		} catch {
			return {
				credentialId: credential.credentialId,
				provider: credential.pool.provider,
				status: "unavailable",
				type: credential.pool.type,
			};
		}
	}
}

export class AuthGatewayObservabilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthGatewayObservabilityError";
	}
}

function diagnosticFor(credential: AuthBrokerCredentialMetadata): CredentialDiagnostic {
	return {
		credentialId: credential.credentialId,
		provider: credential.pool.provider,
		status: credential.disabled === undefined ? "available" : "disabled",
		type: credential.pool.type,
	};
}
