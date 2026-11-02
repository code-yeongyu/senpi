import type * as NodeZlib from "node:zlib";

export const GZIP_REQUEST_BODY_MIN_CHARS = 4096;
const REJECTION_BODY_READ_LIMIT = 8192;
const MAX_LENGTH_PADDING = 256;
// The messages Anthropic returns when it could not decode a body as JSON; Claude Code 2.1.302 matches the same
// two strings to detect a refused gzip body.
const ORIGIN_JSON_PARSE_FAILURES = [
	"The request body is not valid JSON",
	"Failed to parse request: could not parse request body as JSON",
] as const;

type Fetch = typeof globalThis.fetch;
type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

const wrappedFetches = new WeakMap<Fetch, Fetch>();
const uncompressedOrigins = new Set<string>();

function loadNodeZlib(): typeof NodeZlib | undefined {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return undefined;
	return (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib");
}

function originOf(input: Parameters<Fetch>[0]): string {
	const url = input instanceof Request ? input.url : String(input);
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

function lengthPadding(): string {
	const count = Math.floor(Math.random() * (MAX_LENGTH_PADDING + 1));
	let padding = "\n";
	for (let index = 0; index < count; index++) padding += Math.random() < 0.5 ? " " : "\t";
	return padding;
}

async function readBodyPrefix(response: Response): Promise<string> {
	const reader = response.clone().body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (text.length < REJECTION_BODY_READ_LIMIT) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel();
	}
	return text;
}

function isFromAnthropic(response: Response): boolean {
	return response.headers.get("request-id")?.startsWith("req_") === true;
}

/**
 * Whether a non-OK answer to a gzip request means the body encoding itself was refused: a 415, a 400/403
 * from a hop that is not Anthropic (a proxy that cannot decode it), or Anthropic reporting that it could
 * not parse the body as JSON. Other API errors (bad request, rate limits, auth) are returned as they are.
 * A misfire (an unrelated proxy 400/403) costs one uncompressed resend of a request that was never processed
 * and turns gzip off for that origin; it cannot double-bill.
 */
async function isGzipRejection(response: Response): Promise<boolean> {
	if (response.status === 415) return true;
	if (response.status !== 400 && response.status !== 403) return false;
	if (!isFromAnthropic(response)) return true;
	if (response.status !== 400) return false;
	const body = await readBodyPrefix(response);
	return ORIGIN_JSON_PARSE_FAILURES.some((message) => body.includes(message));
}

/**
 * Wraps `fetch` so request bodies of at least {@link GZIP_REQUEST_BODY_MIN_CHARS} characters go out with
 * `Content-Encoding: gzip`. The JSON gets random trailing whitespace before compression so the encrypted
 * length does not reveal how well the content compressed. When an origin refuses the encoding, the same
 * request is resent uncompressed and that origin stays uncompressed for the rest of the process.
 */
export function withGzipRequestBodies(baseFetch: Fetch = globalThis.fetch): Fetch {
	const existing = wrappedFetches.get(baseFetch);
	if (existing) return existing;
	const zlib = loadNodeZlib();
	const wrapped: Fetch = async (input, init) => {
		const body = init?.body;
		const origin = originOf(input);
		if (
			zlib === undefined ||
			typeof body !== "string" ||
			body.length < GZIP_REQUEST_BODY_MIN_CHARS ||
			uncompressedOrigins.has(origin)
		) {
			return baseFetch(input, init);
		}
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set("content-encoding", "gzip");
		headers.delete("content-length");
		const compressed = zlib.gzipSync(body + lengthPadding());
		const response = await baseFetch(input, { ...init, headers, body: new Uint8Array(compressed) });
		if (response.ok || !(await isGzipRejection(response))) return response;
		uncompressedOrigins.add(origin);
		await response.body?.cancel();
		return baseFetch(input, init);
	};
	wrappedFetches.set(baseFetch, wrapped);
	return wrapped;
}
