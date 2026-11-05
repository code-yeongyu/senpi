import type { webcrypto } from "node:crypto";

const ISSUER = "https://auth.openai.com";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CACHE_MS = 5 * 60 * 1000;

export interface OpenAIIdentity {
	subject: string;
	/** Display metadata only; never an account identity or workspace identifier. */
	email?: string;
	issuer: string;
}

export interface OpenAIIdTokenDependencies {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	now: () => number;
}

export class OpenAIIdTokenValidationError extends Error {
	constructor(message: string) {
		super(`OpenAI ID token validation failed: ${message}`);
		this.name = "OpenAIIdTokenValidationError";
	}
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new OpenAIIdTokenValidationError("expected an object");
	}
	return value as Record<string, unknown>;
}

function decode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new OpenAIIdTokenValidationError("invalid JWT encoding");
	return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

/** Each flow instance caches discovery and keys, without caching identity claims. */
export function createOpenAIIdTokenVerifier(deps: OpenAIIdTokenDependencies) {
	let discovery: { jwksUri: string; expires: number } | undefined;
	let jwks: { keys: Record<string, unknown>[]; expires: number } | undefined;

	async function loadKeys(signal: AbortSignal, force = false): Promise<Record<string, unknown>[]> {
		if (!discovery || discovery.expires <= deps.now()) {
			const response = await deps.fetch(DISCOVERY_URL, { signal });
			if (!response.ok) throw new OpenAIIdTokenValidationError("discovery request failed");
			const config = object(await response.json());
			if (typeof config.jwks_uri !== "string" || new URL(config.jwks_uri).protocol !== "https:") {
				throw new OpenAIIdTokenValidationError("invalid discovery JWKS URI");
			}
			discovery = { jwksUri: config.jwks_uri, expires: deps.now() + CACHE_MS };
			jwks = undefined;
		}
		if (force || !jwks || jwks.expires <= deps.now()) {
			const response = await deps.fetch(discovery.jwksUri, { signal });
			if (!response.ok) throw new OpenAIIdTokenValidationError("JWKS request failed");
			const data = object(await response.json());
			if (!Array.isArray(data.keys)) throw new OpenAIIdTokenValidationError("invalid JWKS");
			jwks = { keys: data.keys.map(object), expires: deps.now() + CACHE_MS };
		}
		return jwks.keys;
	}

	return async (idToken: unknown, clientId: string, nonce: string, signal: AbortSignal): Promise<OpenAIIdentity> => {
		try {
			if (typeof idToken !== "string") throw new OpenAIIdTokenValidationError("missing ID token");
			const parts = idToken.split(".");
			if (parts.length !== 3) throw new OpenAIIdTokenValidationError("invalid JWT");
			const [headerPart, payloadPart, signaturePart] = parts;
			const header = object(JSON.parse(new TextDecoder().decode(decode(headerPart))));
			if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.crit !== undefined) {
				throw new OpenAIIdTokenValidationError("unsupported signing header");
			}
			const matchingKey = (key: Record<string, unknown>) =>
				key.kid === header.kid &&
				key.kty === "RSA" &&
				(key.alg === undefined || key.alg === "RS256") &&
				(key.use === undefined || key.use === "sig");
			let keys = await loadKeys(signal);
			if (!keys.some(matchingKey)) keys = await loadKeys(signal, true);
			const matches = keys.filter(matchingKey);
			if (matches.length !== 1) throw new OpenAIIdTokenValidationError("signing key not found or ambiguous");
			const key = await crypto.subtle.importKey(
				"jwk",
				matches[0] as webcrypto.JsonWebKey,
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
			const valid = await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				key,
				decode(signaturePart),
				new TextEncoder().encode(`${headerPart}.${payloadPart}`),
			);
			if (!valid) throw new OpenAIIdTokenValidationError("invalid signature");
			const claims = object(JSON.parse(new TextDecoder().decode(decode(payloadPart))));
			if (claims.iss !== ISSUER) throw new OpenAIIdTokenValidationError("issuer mismatch");
			const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
			if (
				!Array.isArray(audiences) ||
				!audiences.every((aud) => typeof aud === "string") ||
				!audiences.includes(clientId)
			) {
				throw new OpenAIIdTokenValidationError("audience mismatch");
			}
			if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= deps.now() / 1000) {
				throw new OpenAIIdTokenValidationError("expired or missing expiration");
			}
			if (claims.nonce !== nonce) throw new OpenAIIdTokenValidationError("nonce mismatch");
			if (typeof claims.sub !== "string" || !claims.sub.trim()) {
				throw new OpenAIIdTokenValidationError("missing subject");
			}
			return {
				subject: claims.sub,
				issuer: ISSUER,
				...(typeof claims.email === "string" ? { email: claims.email } : {}),
			};
		} catch (error) {
			if (error instanceof OpenAIIdTokenValidationError) throw error;
			// Do not expose tokens, key material, or remote response bodies in login errors.
			throw new OpenAIIdTokenValidationError("could not verify ID token");
		}
	};
}
