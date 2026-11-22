import { z } from "zod";
import { isMcpNeedsAuthError } from "../needs-auth.ts";
import { loadMcpSdkTypes } from "../sdk.lazy.ts";
import {
	buildModernRequest,
	classifyModernError,
	deriveModernHeaders,
	MODERN_PROTOCOL_VERSION,
	type ModernClientInfo,
	type ModernError,
	type ModernRequest,
} from "./wire.ts";

export { MODERN_PROTOCOL_VERSION } from "./wire.ts";
export interface ProbeOptions {
	readonly clientInfo: ModernClientInfo;
	readonly clientCapabilities: Readonly<Record<string, unknown>>;
	readonly supportedVersions: readonly string[];
}
export type ProbeRequest = ModernRequest;
const discoverySchema = z
	.object({
		resultType: z.literal("complete"),
		supportedVersions: z.array(z.string()),
		capabilities: z.record(z.string(), z.unknown()),
		_meta: z
			.object({
				"io.modelcontextprotocol/serverInfo": z.object({ name: z.string(), version: z.string() }).passthrough(),
			})
			.passthrough(),
		instructions: z.string().optional(),
		ttlMs: z.number().nonnegative().optional(),
		cacheScope: z.string().optional(),
	})
	.passthrough();

export type { ModernError } from "./wire.ts";
export type DiscoveryResult = z.infer<typeof discoverySchema>;
type ModernOutcome = {
	readonly kind: "modern-OK" | "modern-version-retry";
	readonly version: string;
	readonly discovery?: DiscoveryResult;
	readonly error?: ModernError;
};
export type EraOutcome =
	| ModernOutcome
	/**
	 * stdio only. `restart`: the probed child exited or its stream failed, so the legacy handshake needs a fresh
	 * process. `silent`: no answer in time; the same process gets the legacy handshake, and a late discovery reply
	 * may still upgrade it.
	 */
	| { readonly kind: "legacy-fallback"; readonly restart?: true; readonly silent?: true }
	| {
			readonly kind: "indeterminate";
			readonly reason: string;
			readonly action: string;
			readonly era?: "modern";
			readonly status?: number;
			readonly cause?: unknown;
	  };
export type ProbeFetch = (url: URL, init: RequestInit) => Promise<Response>;
export type ProbeSend = (request: ProbeRequest) => Promise<unknown>;

export const modernError = classifyModernError;

/** The SDK numbers its own requests from 0; a string id can never answer one of them. */
export const STDIO_PROBE_ID = "senpi-era-probe";

/** Rejection a stdio `ProbeSend` uses when the child gave no answer in time (as opposed to exiting). */
export class StdioProbeSilence extends Error {
	constructor() {
		super("MCP stdio server did not answer discovery in time");
		this.name = "StdioProbeSilence";
	}
}

/** A complete discovery reply to `id`, or undefined. */
export function discoveryReply(value: unknown, id: string | number): DiscoveryResult | undefined {
	return complete(value, id);
}

function request(options: ProbeOptions, version: string, id: string | number = 1): ProbeRequest {
	const built = buildModernRequest(id, "server/discover", options.clientInfo, options.clientCapabilities);
	return {
		...built,
		params: {
			_meta: {
				...built.params._meta,
				"io.modelcontextprotocol/protocolVersion": version,
			},
		},
	};
}

function complete(value: unknown, id: string | number = 1): DiscoveryResult | undefined {
	const parsed = z.object({ jsonrpc: z.literal("2.0"), id: z.literal(id), result: discoverySchema }).safeParse(value);
	return parsed.success ? parsed.data.result : undefined;
}

/** A well-formed JSON-RPC error reply (any code), optionally addressed to `id`. */
function errorReply(value: unknown, id?: string | number): boolean {
	return z
		.object({
			jsonrpc: z.literal("2.0"),
			id: id === undefined ? z.union([z.string(), z.number(), z.null()]) : z.literal(id),
			error: z.object({ code: z.number(), message: z.string() }),
		})
		.safeParse(value).success;
}

/** Preserve modern selection first; the SDK owns the implemented initialize-based versions. */
async function mutualVersion(error: ModernError, options: ProbeOptions): Promise<string | undefined> {
	if (error.kind !== "UnsupportedProtocolVersionError" || !error.supportedVersions) return undefined;
	const modern = error.supportedVersions
		.filter((candidate) => options.supportedVersions.includes(candidate))
		.sort()
		.at(-1);
	if (modern) return modern;
	const { SUPPORTED_PROTOCOL_VERSIONS } = await loadMcpSdkTypes();
	return error.supportedVersions
		.filter((candidate) => SUPPORTED_PROTOCOL_VERSIONS.includes(candidate))
		.sort()
		.at(-1);
}

function noMutualVersion(error: ModernError): EraOutcome {
	const supported = error.kind === "UnsupportedProtocolVersionError" ? error.supportedVersions : undefined;
	return indeterminate(
		"no-mutual-version",
		`Update client or server to share a supported protocol version. Server supported versions: ${supported?.join(", ") ?? "not provided"}.`,
		{ era: "modern" },
	);
}

function indeterminate(
	reason: string,
	action: string,
	details: {
		readonly era?: "modern";
		readonly status?: number;
		readonly cause?: unknown;
	} = {},
): EraOutcome {
	return { kind: "indeterminate", reason, action, ...details };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function body(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return parseJson(text);
	// This consumes only the POST's response stream, never a standalone GET.
	for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
		const data = event
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		const value = parseJson(data);
		if (complete(value) || modernError(value)) return value;
	}
	return undefined;
}

export async function probeHttpEra(url: URL, fetch: ProbeFetch, options: ProbeOptions): Promise<EraOutcome> {
	let version = MODERN_PROTOCOL_VERSION;
	for (let attempt = 0; attempt < 2; attempt++) {
		let response: Response;
		let value: unknown;
		try {
			const discoveryRequest = request(options, version);
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...deriveModernHeaders(discoveryRequest),
				},
				body: JSON.stringify(discoveryRequest),
			});
			value = await body(response);
		} catch (cause) {
			// An authorization failure already started the OAuth flow; let the connect path report needs_auth.
			if (isMcpNeedsAuthError(cause)) throw cause;
			return indeterminate("transport", "Check the MCP endpoint connection and retry discovery.", { cause });
		}
		const error = modernError(value);
		if (response.status === 400) {
			if (!error) {
				return attempt === 0
					? { kind: "legacy-fallback" }
					: indeterminate("version-retry-rejected", "Check server version negotiation; the modern retry failed.", {
							era: "modern",
						});
			}
			if (error.code !== -32022) return { kind: attempt ? "modern-version-retry" : "modern-OK", version, error };
			if (attempt === 1) {
				return indeterminate(
					"version-retry-rejected",
					"Update client or server; the single version retry was rejected.",
					{ era: "modern" },
				);
			}
			const mutual = await mutualVersion(error, options);
			if (!mutual) return noMutualVersion(error);
			if (!options.supportedVersions.includes(mutual)) return { kind: "legacy-fallback" };
			version = mutual;
			continue;
		}
		// A generic JSON-RPC error (no modern code) means the server does not know discovery, whatever the status.
		if (!error && errorReply(value)) {
			return attempt === 0
				? { kind: "legacy-fallback" }
				: indeterminate("version-retry-rejected", "Check server version negotiation; the modern retry failed.", {
						era: "modern",
					});
		}
		if (!response.ok)
			return indeterminate("http-status", "Check endpoint, authentication, or server health before retrying.", {
				status: response.status,
			});
		const discovery = complete(value);
		if (discovery) return { kind: attempt ? "modern-version-retry" : "modern-OK", version, discovery };
		if (error) return { kind: attempt ? "modern-version-retry" : "modern-OK", version, error };
		return indeterminate("invalid-discovery", "Check that the server returns a complete server/discover envelope.");
	}
	return indeterminate("version-retry-rejected", "Update client or server protocol versions.", { era: "modern" });
}

/**
 * `send` resolves with the reply to its request id, and rejects with `StdioProbeSilence` when no reply came in time
 * or with any other error when the child exited or its stream failed. Once a server has shown it is modern
 * (a -32022), an unclean retry is never downgraded to legacy.
 */
export async function probeStdioEra(send: ProbeSend, options: ProbeOptions): Promise<EraOutcome> {
	let version = MODERN_PROTOCOL_VERSION;
	const retryRejected = () =>
		indeterminate("version-retry-rejected", "Update client or server; the single version retry was rejected.", {
			era: "modern",
		});
	for (let attempt = 0; attempt < 2; attempt++) {
		const id = attempt === 0 ? STDIO_PROBE_ID : `${STDIO_PROBE_ID}-${attempt}`;
		let value: unknown;
		try {
			value = await send(request(options, version, id));
		} catch (error) {
			if (attempt > 0) return retryRejected();
			return error instanceof StdioProbeSilence
				? { kind: "legacy-fallback", silent: true }
				: { kind: "legacy-fallback", restart: true };
		}
		const kind = attempt === 0 ? "modern-OK" : "modern-version-retry";
		const discovery = complete(value, id);
		if (discovery) return { kind, version, discovery };
		if (!errorReply(value, id)) return attempt > 0 ? retryRejected() : { kind: "legacy-fallback", restart: true };
		const error = modernError(value);
		if (!error) return attempt > 0 ? retryRejected() : { kind: "legacy-fallback" };
		const mutual = attempt === 0 ? await mutualVersion(error, options) : undefined;
		if (attempt === 0 && error.code === -32022 && !mutual) return noMutualVersion(error);
		if (!mutual) return { kind, version, error };
		if (!options.supportedVersions.includes(mutual)) return { kind: "legacy-fallback" };
		version = mutual;
	}
	return retryRejected();
}
