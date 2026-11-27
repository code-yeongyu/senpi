// SC-LIVE O3/O4 at the wire: a local reverse proxy between the CLI and its provider. It forwards every request byte for
// byte to the upstream origin and streams the response back unchanged, and records, per request, the tool declarations
// in the body (O3) and the full header set (O4) with credential values hashed (plan §6.2: synthetic or real credential
// identities are compared as hashes only). It never logs a credential value or a body beyond its `tools`.
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { zstdDecompressSync } from "node:zlib";

const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"proxy-authorization",
	"cookie",
	"api-key",
	"x-goog-api-key",
]);
/** Hop-by-hop and framing headers: derived from the connection and the body bytes, never forwarded or compared. */
const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"]);
const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;

/** The O4 form of a header set: lower-case names, sorted, framing dropped, credential values hashed. */
export function sanitizeHeaders(headers) {
	return Object.fromEntries(
		Object.entries(headers ?? {})
			.map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value])
			.filter(([name, value]) => value !== undefined && !HOP_HEADERS.has(name))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, value]) => [name, CREDENTIAL_HEADERS.has(name) ? sha(value) : value]),
	);
}

function toolsOf(bytes, encoding) {
	try {
		const text = (encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8");
		const body = text ? JSON.parse(text) : {};
		return Array.isArray(body.tools) ? body.tools : null;
	} catch {
		return null;
	}
}

/** @returns {Promise<{ origin: string, records: Array<{ method: string, url: string, tools: unknown, headers: object }>, stop: () => Promise<void> }>} */
export function startRecordingProxy(upstreamOrigin) {
	const records = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const bytes = Buffer.concat(chunks);
			if (req.method === "POST")
				records.push({
					method: req.method,
					url: req.url,
					tools: toolsOf(bytes, req.headers["content-encoding"]),
					headers: sanitizeHeaders(req.headers),
				});
			// node:http forwards exactly the headers the CLI sent (fetch would add its own), except the hop-by-hop ones.
			const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)));
			if (bytes.length > 0) headers["content-length"] = String(bytes.length);
			const target = new URL(`${upstreamOrigin}${req.url}`);
			const send = target.protocol === "https:" ? httpsRequest : httpRequest;
			const upstream = send(target, { method: req.method, headers }, (response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			});
			upstream.on("error", (error) => {
				if (res.headersSent) return void res.destroy(error);
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `live proxy: ${error.message}` } }));
			});
			upstream.end(bytes);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const origin = `http://127.0.0.1:${server.address().port}`;
			resolve({
				origin,
				records,
				stop: () =>
					new Promise((done) => {
						server.closeAllConnections?.();
						server.close(() => done());
					}),
			});
		});
	});
}
