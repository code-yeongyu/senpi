/**
 * The base URL a region-tagged RPC `verify_api_key` probes (senpi#5649). The region is
 * resolved through the provider's own API-key login — the same answers `/login` gets, so
 * an unknown region or a region for a provider whose key has none fails here exactly as
 * `login_api_key` fails — and then through the provider's own auth resolve, which is the
 * mapping the `/login` Kimi Code flow uses to route a region to its host. Nothing is
 * stored: the credential only lives long enough to read its host.
 *
 * `undefined` means the region does not move inference off the catalog host (Kimi Code's
 * default `mainland-cn` region), so the caller probes the catalog base URL as before.
 */
import { defaultProviderAuthContext, type Provider } from "@earendil-works/pi-ai";
import { apiKeyLoginCredential } from "./api-key-login-credential.ts";

export async function verifyApiKeyRegionBaseUrl(
	provider: Provider | undefined,
	key: string,
	region: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const credential = await apiKeyLoginCredential(provider, key, region);
	const resolve = provider?.auth.apiKey?.resolve;
	if (resolve === undefined) return undefined;
	const resolved = await resolve({
		ctx: defaultProviderAuthContext(),
		credential,
		signal,
	});
	return resolved?.auth.baseUrl;
}
