import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpStoredAuth } from "./token-store.ts";

// A dynamic client registration is bound to the `redirect_uris` it was made with, and exact-matching
// authorization servers reject an authorize request whose `redirect_uri` the client never registered
// ("Mismatching Redirect URL"). Background connects register the `127.0.0.1:0` placeholder and every
// `/mcp auth` binds a new loopback port, so a flow that sends an authorize request may only reuse a stored
// registration that names its own redirect URI (senpi#6327).

/** Whether a stored registration may serve a flow that sends `redirectUrl`; one without `redirect_uris` is kept. */
export function registrationNamesRedirect(
	registration: OAuthClientInformationFull | undefined,
	redirectUrl: string | URL | undefined,
): boolean {
	const registered = registration?.redirect_uris;
	if (registered === undefined || redirectUrl === undefined) return true;
	return registered.some((uri) => String(uri) === String(redirectUrl));
}

/**
 * Stores a new registration. When it replaces another client, that client's refresh token goes with it: the
 * grant was issued to the replaced `client_id`, and the SDK would otherwise present it under the new one.
 */
export function withRegistration(
	current: McpStoredAuth | undefined,
	clientInfo: OAuthClientInformationFull,
): McpStoredAuth {
	const next: McpStoredAuth = { ...(current ?? {}), clientInfo };
	const replaced = current?.clientInfo?.client_id;
	if (replaced !== undefined && replaced !== clientInfo.client_id) delete next.refreshToken;
	return next;
}
