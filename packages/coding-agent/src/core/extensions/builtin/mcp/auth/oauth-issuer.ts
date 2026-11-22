import type { OAuthDiscoveryState, OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthFlowError } from "./oauth-errors.ts";
import type { McpStoredAuth } from "./token-store.ts";

// Credential stamps tolerate only the slash spelling of an origin-only URL, not URL normalization.
export function canonicalAuthorizationServerIssuer(issuer: string): string {
	return issuer.replace(/^(https?:\/\/[^/?#]+)\/$/, "$1");
}

/**
 * Whether a stored discovery record carries its own evidence for the authorization server it names (senpi#4924):
 * that server's metadata, the MCP server's protected-resource metadata naming it, or the MCP server's own origin
 * (the SDK's legacy root fallback). A bare URL from anywhere else would send the SDK to an unverified server.
 */
export function discoveryNamesItsServer(state: OAuthDiscoveryState, serverUrl: string): boolean {
	if (state.authorizationServerMetadata !== undefined) return true;
	const named = canonicalAuthorizationServerIssuer(String(state.authorizationServerUrl));
	if (named === new URL(serverUrl).origin) return true;
	return (
		state.resourceMetadata?.authorization_servers?.some(
			(server) => canonicalAuthorizationServerIssuer(String(server)) === named,
		) ?? false
	);
}

// RFC 8414 section 3.3: identifiers from metadata are compared verbatim, not as normalized URLs.
export function validatedAuthorizationServerIssuer(info: OAuthServerInfo, serverName: string): string {
	// The SDK's legacy fallback discovers root metadata and spells the origin with a trailing slash.
	// Only that configured-resource fallback is normalized; PRM-provided identifiers remain exact.
	const origin = new URL(info.authorizationServerUrl).origin;
	const issuer =
		!info.resourceMetadata?.authorization_servers?.length && info.authorizationServerUrl === `${origin}/`
			? canonicalAuthorizationServerIssuer(info.authorizationServerUrl)
			: info.authorizationServerUrl;
	if (info.authorizationServerMetadata !== undefined && info.authorizationServerMetadata.issuer !== issuer) {
		throw new OAuthFlowError(
			"needs_auth",
			`MCP server ${serverName} authorization server metadata issuer mismatch; restart authorization after correcting the server metadata.`,
			{ serverName },
		);
	}
	return issuer;
}

export function credentialsMatchIssuer(record: McpStoredAuth | undefined, issuer: string): boolean {
	const grantIssuer = record?.issuer ?? record?.discoveryState?.authorizationServerUrl;
	const clientIssuer = record?.clientInfo?.issuer ?? grantIssuer;
	return [grantIssuer, clientIssuer].every(
		(stamp) =>
			stamp === undefined ||
			canonicalAuthorizationServerIssuer(stamp) === canonicalAuthorizationServerIssuer(issuer),
	);
}
