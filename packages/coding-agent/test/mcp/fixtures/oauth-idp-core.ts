// RFC-compliant OAuth 2.1 fixture identity provider state + handlers.
// Pure logic (no HTTP wiring) so oauth-idp.ts stays a thin router and the
// refresh-race / reuse-detection behaviour is unit-inspectable.
import { createHash, randomBytes } from "node:crypto";

export interface IdpOptions {
	noS256: boolean;
	rotateRefresh: boolean;
	cimd: boolean;
	oidcOnly: boolean;
	expireAccessSec: number;
}

export interface HttpReply {
	status: number;
	headers?: Record<string, string>;
	body?: unknown;
	redirect?: string;
}

interface IssuedCode {
	clientId: string;
	redirectUri: string;
	codeChallenge?: string;
	method?: string;
	resource?: string;
	scope?: string;
	used: boolean;
	expiresAt: number;
}

interface RefreshToken {
	family: string;
	used: boolean;
	scope?: string;
	resource?: string;
}

export interface RequestLogEntry {
	method: string;
	path: string;
	grantType?: string;
	resource?: string;
	note?: string;
}

const SENTINEL = "SENTINEL";

export class IdpState {
	readonly options: IdpOptions;
	baseUrl = "";
	readonly requests: RequestLogEntry[] = [];
	tokenHits = 0;
	registerHits = 0;
	discoveryHits = 0;
	familyInvalidated = false;
	readonly #codes = new Map<string, IssuedCode>();
	readonly #refresh = new Map<string, RefreshToken>();
	readonly #revokedFamilies = new Set<string>();
	readonly #accessTokens = new Map<string, number>();

	constructor(options: IdpOptions) {
		this.options = options;
	}

	log(entry: RequestLogEntry): void {
		this.requests.push(entry);
	}

	isAccessTokenValid(token: string): boolean {
		const expiresAt = this.#accessTokens.get(token);
		return expiresAt !== undefined && expiresAt > Date.now();
	}

	protectedResourceMetadata(): HttpReply {
		this.discoveryHits++;
		return { status: 200, body: { resource: `${this.baseUrl}/mcp`, authorization_servers: [this.baseUrl] } };
	}

	authorizationServerMetadata(kind: "oauth" | "oidc"): HttpReply {
		this.discoveryHits++;
		if (kind === "oauth" && this.options.oidcOnly) return { status: 404, body: { error: "not_found" } };
		const base: Record<string, unknown> = {
			issuer: this.baseUrl,
			authorization_endpoint: `${this.baseUrl}/authorize`,
			token_endpoint: `${this.baseUrl}/token`,
			registration_endpoint: `${this.baseUrl}/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
			scopes_supported: ["mcp", "offline_access"],
		};
		if (!this.options.noS256) base.code_challenge_methods_supported = ["S256"];
		if (this.options.cimd) base.client_id_metadata_document_supported = true;
		if (kind === "oidc") {
			base.jwks_uri = `${this.baseUrl}/jwks`;
			base.subject_types_supported = ["public"];
			base.id_token_signing_alg_values_supported = ["RS256"];
		}
		return { status: 200, body: base };
	}

	clientMetadataDocument(): HttpReply {
		return {
			status: 200,
			body: {
				client_id: `${this.baseUrl}/cimd`,
				redirect_uris: ["http://127.0.0.1/callback"],
				grant_types: ["authorization_code", "refresh_token"],
				token_endpoint_auth_method: "none",
			},
		};
	}

	register(body: Record<string, unknown>): HttpReply {
		this.registerHits++;
		const clientId = `dcr-${randomBytes(6).toString("hex")}`;
		return {
			status: 201,
			body: { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) },
		};
	}

	authorize(query: URLSearchParams): HttpReply {
		const redirectUri = query.get("redirect_uri");
		const state = query.get("state");
		if (redirectUri === null) return { status: 400, body: { error: "invalid_request" } };
		const code = `code-${randomBytes(12).toString("hex")}`;
		this.#codes.set(code, {
			clientId: query.get("client_id") ?? "unknown",
			redirectUri,
			codeChallenge: query.get("code_challenge") ?? undefined,
			method: query.get("code_challenge_method") ?? undefined,
			resource: query.get("resource") ?? undefined,
			scope: query.get("scope") ?? undefined,
			used: false,
			expiresAt: Date.now() + 300_000,
		});
		const url = new URL(redirectUri);
		url.searchParams.set("code", code);
		if (state !== null) url.searchParams.set("state", state);
		return { status: 302, redirect: url.toString() };
	}

	token(params: URLSearchParams): HttpReply {
		this.tokenHits++;
		const grantType = params.get("grant_type") ?? "";
		this.log({ method: "POST", path: "/token", grantType, resource: params.get("resource") ?? undefined });
		if (grantType === "authorization_code") return this.#authorizationCode(params);
		if (grantType === "refresh_token") return this.#refreshToken(params);
		if (grantType === "client_credentials") return this.#clientCredentials(params);
		return { status: 400, body: { error: "unsupported_grant_type" } };
	}

	#authorizationCode(params: URLSearchParams): HttpReply {
		const code = params.get("code") ?? "";
		const record = this.#codes.get(code);
		if (record === undefined || record.used || record.expiresAt < Date.now()) {
			return {
				status: 400,
				body: { error: "invalid_grant", error_description: "authorization code invalid or used" },
			};
		}
		if (params.get("resource") === null) {
			return { status: 400, body: { error: "invalid_target", error_description: "RFC 8707 resource required" } };
		}
		const verifier = params.get("code_verifier");
		if (!this.options.noS256) {
			if (verifier === null || record.codeChallenge === undefined || pkceS256(verifier) !== record.codeChallenge) {
				return { status: 400, body: { error: "invalid_grant", error_description: "PKCE verification failed" } };
			}
		}
		record.used = true;
		return { status: 200, body: this.#issueTokens(newFamily(), record.scope, params.get("resource") ?? undefined) };
	}

	#refreshToken(params: URLSearchParams): HttpReply {
		const token = params.get("refresh_token") ?? "";
		if (token === "RT_TRANSIENT") {
			// Knob: models a flaky token endpoint (transient, not terminal).
			return { status: 500, body: { error: "temporarily_unavailable" } };
		}
		const record = this.#refresh.get(token);
		if (record === undefined || this.#revokedFamilies.has(record.family)) {
			return { status: 400, body: { error: "invalid_grant", error_description: "refresh token revoked" } };
		}
		if (record.used) {
			// Reuse of a rotated refresh token => the whole family is compromised.
			this.#revokedFamilies.add(record.family);
			this.familyInvalidated = true;
			return { status: 400, body: { error: "invalid_grant", error_description: "refresh token reuse detected" } };
		}
		if (this.options.rotateRefresh) record.used = true;
		const resource = params.get("resource") ?? record.resource;
		return {
			status: 200,
			body: this.#issueTokens(record.family, record.scope, resource, this.options.rotateRefresh ? undefined : token),
		};
	}

	#clientCredentials(params: URLSearchParams): HttpReply {
		const access = this.#mintAccessToken();
		this.log({ method: "POST", path: "/token", grantType: "client_credentials", note: "m2m" });
		return {
			status: 200,
			body: {
				access_token: access,
				token_type: "Bearer",
				expires_in: this.options.expireAccessSec,
				scope: params.get("scope") ?? "mcp",
			},
		};
	}

	#issueTokens(
		family: string,
		scope: string | undefined,
		resource: string | undefined,
		keepRefresh?: string,
	): Record<string, unknown> {
		const access = this.#mintAccessToken();
		let refresh = keepRefresh;
		if (refresh === undefined) {
			refresh = `${SENTINEL}_RT_${randomBytes(9).toString("hex")}`;
			this.#refresh.set(refresh, { family, used: false, scope, resource });
		}
		return {
			access_token: access,
			refresh_token: refresh,
			token_type: "Bearer",
			expires_in: this.options.expireAccessSec,
			scope: scope ?? "mcp",
		};
	}

	#mintAccessToken(): string {
		const access = `${SENTINEL}_AT_${randomBytes(9).toString("hex")}`;
		this.#accessTokens.set(access, Date.now() + this.options.expireAccessSec * 1000);
		return access;
	}
}

export function pkceS256(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

function newFamily(): string {
	return `fam-${randomBytes(6).toString("hex")}`;
}

export function parseIdpOptions(argv: string[]): IdpOptions {
	const expireIndex = argv.indexOf("--expire-access");
	const expireAccessSec = expireIndex >= 0 ? Number.parseInt(argv[expireIndex + 1] ?? "3600", 10) : 3600;
	return {
		noS256: argv.includes("--no-s256"),
		rotateRefresh: argv.includes("--rotate-refresh"),
		cimd: argv.includes("--cimd"),
		oidcOnly: argv.includes("--oidc-only"),
		expireAccessSec: Number.isFinite(expireAccessSec) ? expireAccessSec : 3600,
	};
}
