import { encodeMcpHeaderValue } from "./parameter-headers.ts";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MODERN_ERROR_CODES = {
	HeaderMismatch: -32020,
	MissingRequiredClientCapabilityError: -32021,
	UnsupportedProtocolVersionError: -32022,
} as const;

export type ModernClientInfo = {
	readonly name: string;
	readonly version: string;
};

export type ModernRequestMeta = Readonly<Record<string, unknown>> & {
	readonly "io.modelcontextprotocol/protocolVersion": string;
	readonly "io.modelcontextprotocol/clientInfo": ModernClientInfo;
	readonly "io.modelcontextprotocol/clientCapabilities": Readonly<Record<string, unknown>>;
};

export type ModernRequest = {
	readonly jsonrpc: "2.0";
	readonly id: string | number;
	readonly method: string;
	readonly params: Readonly<Record<string, unknown>> & { readonly _meta: ModernRequestMeta };
};

export function buildModernRequest(
	id: string | number,
	method: string,
	clientInfo: ModernClientInfo,
	clientCapabilities: Readonly<Record<string, unknown>>,
	params: Readonly<Record<string, unknown>> & { readonly _meta?: Readonly<Record<string, unknown>> } = {},
): ModernRequest {
	return {
		jsonrpc: "2.0",
		id,
		method,
		params: {
			...params,
			_meta: {
				...params._meta,
				"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientInfo": clientInfo,
				"io.modelcontextprotocol/clientCapabilities": clientCapabilities,
			},
		},
	};
}

/** Rewrite an outgoing SDK request or notification into the modern wire shape at the negotiated version. */
export function modernizeRequest(
	id: string | number,
	method: string,
	clientInfo: ModernClientInfo,
	clientCapabilities: Readonly<Record<string, unknown>>,
	version: string,
	params?: Readonly<Record<string, unknown>> & { readonly _meta?: Readonly<Record<string, unknown>> },
): ModernRequest {
	const built = buildModernRequest(id, method, clientInfo, clientCapabilities, params);
	const capabilities = params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
	return {
		...built,
		params: {
			...built.params,
			_meta: {
				...built.params._meta,
				"io.modelcontextprotocol/clientCapabilities": isRecord(capabilities) ? capabilities : clientCapabilities,
				"io.modelcontextprotocol/protocolVersion": version,
			},
		},
	};
}

/** Derive protocol headers from the same request that will be serialized. */
export function deriveModernHeaders(request: ModernRequest): Record<string, string> {
	const headers: Record<string, string> = {
		"MCP-Protocol-Version": request.params._meta["io.modelcontextprotocol/protocolVersion"],
		"Mcp-Method": request.method,
	};
	const name =
		request.method === "resources/read"
			? request.params.uri
			: request.method === "tools/call" || request.method === "prompts/get"
				? request.params.name
				: undefined;
	if (typeof name === "string") {
		headers["Mcp-Name"] = encodeMcpHeaderValue(name);
	}
	return headers;
}

export type ModernResult = Readonly<Record<string, unknown>> & { readonly resultType: string };

export class ModernWireError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModernWireError";
	}
}

/** Parse the common envelope only; method-specific payloads remain available to their own parsers. */
export function parseModernResult(response: unknown): ModernResult {
	if (!isRecord(response) || response.jsonrpc !== "2.0" || "error" in response || !isRecord(response.result)) {
		throw new ModernWireError("Invalid MCP result envelope");
	}
	const result = response.result;
	if (result.resultType === undefined) return { ...result, resultType: "complete" };
	if (typeof result.resultType !== "string") throw new ModernWireError("Invalid MCP resultType");
	return { ...result, resultType: result.resultType };
}

type ModernErrorBase = {
	readonly message: string;
	readonly data?: unknown;
};

export type ModernError = ModernErrorBase &
	(
		| { readonly kind: "HeaderMismatch"; readonly code: -32020 }
		| { readonly kind: "MissingRequiredClientCapabilityError"; readonly code: -32021 }
		| {
				readonly kind: "UnsupportedProtocolVersionError";
				readonly code: -32022;
				readonly supportedVersions?: readonly string[];
		  }
	);

/** Only the modern-specific codes establish the era, never generic JSON-RPC errors or message text. */
export function classifyModernError(body: unknown): ModernError | undefined {
	const response = parseBody(body);
	if (!isRecord(response) || response.jsonrpc !== "2.0" || !isRecord(response.error)) return undefined;
	const error = response.error;
	if (typeof error.message !== "string") return undefined;
	const common = { message: error.message, ...("data" in error ? { data: error.data } : {}) };
	switch (error.code) {
		case MODERN_ERROR_CODES.HeaderMismatch:
			return { ...common, kind: "HeaderMismatch", code: error.code };
		case MODERN_ERROR_CODES.MissingRequiredClientCapabilityError:
			return { ...common, kind: "MissingRequiredClientCapabilityError", code: error.code };
		case MODERN_ERROR_CODES.UnsupportedProtocolVersionError: {
			const supported = isRecord(error.data) ? error.data.supported : undefined;
			return {
				...common,
				kind: "UnsupportedProtocolVersionError",
				code: error.code,
				...(Array.isArray(supported) && supported.every((version): version is string => typeof version === "string")
					? { supportedVersions: supported }
					: {}),
			};
		}
		default:
			return undefined;
	}
}

export function classifyHttpProbeError(status: number, body: unknown): "modern" | "legacy" | "indeterminate" {
	if (status !== 400) return "indeterminate";
	return classifyModernError(body) === undefined ? "legacy" : "modern";
}

export function classifyStdioProbeError(body: unknown): "modern" | "legacy" {
	return classifyModernError(body) === undefined ? "legacy" : "modern";
}

function parseBody(body: unknown): unknown {
	if (typeof body !== "string") return body;
	try {
		return JSON.parse(body);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
