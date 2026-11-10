// Command-line options of the fixture identity provider (oauth-idp.ts argv).
export interface IdpOptions {
	noS256: boolean;
	rotateRefresh: boolean;
	cimd: boolean;
	oidcOnly: boolean;
	expireAccessSec: number;
	/** Send `null` / `""` for optional token and registration fields, as some servers do. */
	nullOptionalFields: boolean;
	/** RFC 9207 `iss` on the authorization response: omitted, this issuer, or another issuer. */
	iss: "omit" | "match" | "mismatch";
	/** Advertise `authorization_response_iss_parameter_supported` in the server metadata. */
	issSupported: boolean;
	/**
	 * Reject an authorize request whose `redirect_uri` is not one the client registered, byte for byte, as
	 * exact-matching authorization servers (django-oauth-toolkit, Neon) do (senpi#6327).
	 */
	strictRedirectUris: boolean;
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
		nullOptionalFields: argv.includes("--null-optional-fields"),
		iss: parseIssMode(argv),
		issSupported: argv.includes("--iss-supported"),
		strictRedirectUris: argv.includes("--strict-redirect"),
	};
}

function parseIssMode(argv: string[]): IdpOptions["iss"] {
	const index = argv.indexOf("--iss");
	if (index < 0) return "omit";
	const mode = argv[index + 1];
	if (mode === "match" || mode === "mismatch") return mode;
	throw new Error(`--iss must be match or mismatch, got ${String(mode)}`);
}
