/**
 * Lazy boundary for `@modelcontextprotocol/sdk`.
 *
 * The SDK is 210 files / ~1.16 MB and every CLI start used to parse, compile
 * and evaluate all of it, because the mcp builtin is statically reachable from
 * the builtin barrel. Nothing in the SDK is needed until a run actually
 * connects a transport, builds a client, registers a request handler or drives
 * the OAuth flow — all of which happen inside already-async code paths — so
 * each SDK submodule loads on first use instead of at process start.
 *
 * Follows the repository's documented lazy-boundary pattern
 * (`packages/ai/src/api/*.lazy.ts`, `webfetch/webfetch/content.lazy.ts`);
 * `test/suite/regressions/1781-lazy-mcp-sdk.test.ts` fails if a static edge to
 * the SDK reappears in `dist/main.js`.
 */

type SdkAuthModule = typeof import("@modelcontextprotocol/sdk/client/auth.js");

/**
 * Loads once and caches. Concurrent callers share the in-flight promise; a
 * failed load is not cached, so a later attempt can retry.
 */
function memoizeLoader<T>(load: () => Promise<T>): () => Promise<T> {
	let loaded: T | undefined;
	let loading: Promise<T> | undefined;
	return (): Promise<T> => {
		if (loaded !== undefined) return Promise.resolve(loaded);
		loading ??= load()
			.then((module) => {
				loaded = module;
				return module;
			})
			.finally(() => {
				loading = undefined;
			});
		return loading;
	};
}

/** `Client` — the MCP client class, built once per transport connection. */
export const loadMcpSdkClient = memoizeLoader(() => import("@modelcontextprotocol/sdk/client/index.js"));

/** `StdioClientTransport` + `getDefaultEnvironment` — stdio servers and the stdio diagnostic rerun. */
export const loadMcpSdkStdioTransport = memoizeLoader(() => import("@modelcontextprotocol/sdk/client/stdio.js"));

/** Protocol schemas (currently only the elicitation request schema). */
export const loadMcpSdkTypes = memoizeLoader(() => import("@modelcontextprotocol/sdk/types.js"));

let authModule: SdkAuthModule | undefined;

/** OAuth 2.1 discovery, authorization, token exchange and refresh. */
export const loadMcpSdkAuth = memoizeLoader(async (): Promise<SdkAuthModule> => {
	const module = await import("@modelcontextprotocol/sdk/client/auth.js");
	authModule = module;
	return module;
});

/**
 * `StreamableHTTPClientTransport`. Loading it also seats the auth module: the
 * HTTP transport is the only transport that raises the SDK's
 * `UnauthorizedError`, and {@link isMcpSdkUnauthorizedError} can only recognize
 * an instance once the class that produced it is cached here. `auth.js` is
 * already part of `streamableHttp.js`'s own static graph, so this is free.
 */
export const loadMcpSdkStreamableHttpTransport = memoizeLoader(async () => {
	const [module] = await Promise.all([import("@modelcontextprotocol/sdk/client/streamableHttp.js"), loadMcpSdkAuth()]);
	return module;
});

/**
 * Whether `error` is the SDK's `UnauthorizedError` (the signal that a server
 * needs OAuth). Synchronous on purpose — every caller is a plain error
 * predicate — and exact: an instance can only exist once `auth.js` has been
 * evaluated, and every path that can produce one awaits a loader above first.
 * The class carries no distinguishing `name`, so identity is the only check.
 */
export function isMcpSdkUnauthorizedError(error: unknown): boolean {
	return authModule !== undefined && error instanceof authModule.UnauthorizedError;
}
