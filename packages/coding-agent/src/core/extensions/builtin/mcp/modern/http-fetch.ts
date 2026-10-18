import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { fetchWithinOrigin } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadMcpSdkAuth } from "../sdk.lazy.ts";
import type { McpHttpTransportSpec } from "../transport-sdk.ts";

/** The existing OAuth provider owns credentials; the SDK owns authorization and origin-safe redirects. */
export function modernHttpFetch(spec: McpHttpTransportSpec, signal: AbortSignal): FetchLike {
	const fetch = fetchWithinOrigin();
	return async (url, init) => {
		const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
		const send = () => {
			const headers = new Headers();
			const tokens = spec.authProvider?.tokens();
			if (tokens) headers.set("Authorization", `Bearer ${tokens.access_token}`);
			new Headers(spec.requestInit?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			for (const key of ["Mcp-Session-Id", "Mcp-Name", "Mcp-Method", "MCP-Protocol-Version"]) headers.delete(key);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			headers.delete("Mcp-Session-Id");
			return fetch(url, {
				...spec.requestInit,
				...init,
				headers,
				signal: requestSignal,
			});
		};
		let response = await send();
		if (spec.authProvider && (response.status === 401 || response.status === 403)) {
			const { auth, extractWWWAuthenticateParams, UnauthorizedError } = await loadMcpSdkAuth();
			const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
			if (response.status === 401 || error === "insufficient_scope") {
				await response.body?.cancel();
				const result = await auth(spec.authProvider, {
					serverUrl: spec.url,
					resourceMetadataUrl,
					scope,
					fetchFn: (target, request) =>
						fetch(target, {
							...request,
							signal: request?.signal ? AbortSignal.any([requestSignal, request.signal]) : requestSignal,
						}),
				});
				if (result !== "AUTHORIZED") throw new UnauthorizedError();
				response = await send();
				if (response.status === 401) {
					await response.body?.cancel();
					throw new UnauthorizedError("Server returned 401 after successful authentication");
				}
			}
		}
		return response;
	};
}
