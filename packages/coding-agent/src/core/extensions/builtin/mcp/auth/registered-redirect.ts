import type { McpClientRegistration, McpStoredAuth } from "./token-store.ts";

// A dynamic client registration is bound to the `redirect_uris` it was made with, and exact-matching
// authorization servers reject an authorize request whose `redirect_uri` the client never registered
// ("Mismatching Redirect URL"). Background connects register the `127.0.0.1:0` placeholder and every
// `/mcp auth` binds a new loopback port, so a flow that sends an authorize request may only reuse a stored
// registration that names its own redirect URI (senpi#6327).
//
// A new registration made by such a flow is staged in `pendingClientInfo`: the signed-in client and its refresh
// token keep serving background refreshes until the flow's code exchange succeeds, so an abandoned sign-in
// costs nothing.

/** The provider options that decide which registration a flow uses. */
export interface RegistrationFlow {
	readonly redirectUrl?: string | URL | undefined;
	/** The flow sends an authorize request to `redirectUrl`. */
	readonly requireRegisteredRedirect?: boolean | undefined;
}

// Matched against the redirect URIs the client sent when it registered: an authorization server may echo them
// rewritten. A registration saved before that record existed falls back to the echo; one with neither is kept.
function registrationNamesRedirect(
	registration: McpClientRegistration,
	redirectUrl: string | URL | undefined,
): boolean {
	const registered = registration.redirectUrisSent ?? registration.redirect_uris;
	if (registered === undefined || redirectUrl === undefined) return true;
	return registered.some((uri) => String(uri) === String(redirectUrl));
}

/** The registration a flow uses: for an authorizing flow, the signed-in or staged client naming its redirect URI. */
export function registrationForFlow(
	record: McpStoredAuth | undefined,
	flow: RegistrationFlow,
): McpClientRegistration | undefined {
	if (flow.requireRegisteredRedirect !== true) return record?.clientInfo;
	return [record?.clientInfo, record?.pendingClientInfo].find(
		(registration) => registration !== undefined && registrationNamesRedirect(registration, flow.redirectUrl),
	);
}

/** The flow runs on a staged client: the signed-in client and its grant belong to another flow (senpi#6339). */
export function usesStagedRegistration(record: McpStoredAuth | undefined, flow: RegistrationFlow): boolean {
	const registration = registrationForFlow(record, flow);
	return registration !== undefined && registration === record?.pendingClientInfo;
}

/** The stored grant as a flow may present it: a staged client has no grant, so the refresh token is withheld. */
export function grantForFlow(record: McpStoredAuth | undefined, flow: RegistrationFlow): McpStoredAuth | undefined {
	if (record === undefined || !usesStagedRegistration(record, flow)) return record;
	const grant: McpStoredAuth = { ...record };
	delete grant.refreshToken;
	return grant;
}

/**
 * Stores a registration. An authorizing flow stages a client that would replace the signed-in one; otherwise a
 * replaced client's refresh token goes with it, because the SDK would present it under the new `client_id`.
 */
export function withRegistration(
	current: McpStoredAuth | undefined,
	clientInfo: McpClientRegistration,
	flow: RegistrationFlow,
): McpStoredAuth {
	const known = [current?.clientInfo, current?.pendingClientInfo].find(
		(registration) => registration?.client_id === clientInfo.client_id,
	);
	// The SDK registers with `clientMetadata.redirect_uris`, which is exactly the flow's redirect URL. A re-save of a
	// known client keeps the URIs it was registered with unless the caller supplies them (senpi#6339).
	const sent = clientInfo.redirectUrisSent ?? known?.redirectUrisSent;
	const registration =
		known !== undefined
			? sent === undefined
				? clientInfo
				: { ...clientInfo, redirectUrisSent: sent }
			: flow.redirectUrl === undefined
				? clientInfo
				: { ...clientInfo, redirectUrisSent: [String(flow.redirectUrl)] };
	const replaced = current?.clientInfo?.client_id;
	if (replaced === undefined || replaced === registration.client_id)
		return { ...(current ?? {}), clientInfo: registration };
	if (flow.requireRegisteredRedirect === true) return { ...current, pendingClientInfo: registration };
	const next: McpStoredAuth = { ...current, clientInfo: registration };
	delete next.refreshToken;
	return next;
}

/**
 * What a failed flow on a staged client may discard (senpi#6339): never the signed-in client or its grant, which that
 * flow never presented. Its tokens are the signed-in client's, so "tokens" keeps them; "client" and "all" drop the
 * staged client, and "all" its verifier too.
 */
export function withoutStagedFlowCredentials(
	current: McpStoredAuth | undefined,
	scope: "all" | "client" | "tokens",
): McpStoredAuth | undefined {
	if (current === undefined || scope === "tokens") return current;
	const next: McpStoredAuth = { ...current };
	delete next.pendingClientInfo;
	if (scope === "all") next.codeVerifier = undefined;
	return next;
}

/** After an authorizing flow's code exchange: its staged client replaces the signed-in one and that client's grant. */
export function withPromotedRegistration(
	current: McpStoredAuth | undefined,
	flow: RegistrationFlow,
): McpStoredAuth | undefined {
	if (current?.pendingClientInfo === undefined || !usesStagedRegistration(current, flow)) return current;
	const next: McpStoredAuth = { ...current, clientInfo: current.pendingClientInfo };
	delete next.pendingClientInfo;
	delete next.refreshToken;
	return next;
}
