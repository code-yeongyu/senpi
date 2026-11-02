// VER-E19-RAW: the E19 raw-hash compare over the Cursor run request's content-addressed blobs.
//
// The run request names its prompt by blob id (sha256 of the blob bytes); the normalizer maps those ids one-to-one to
// `<id:N>` tokens, so on its own the compare cannot see the prompt the ids name: a dropped prompt segment changes the
// hash, and the token stays `<id:2>`. The hashed bytes also carry run-scoped values (the sandbox cwd, the checkout path
// in the skill roots, the date, the host facts), so a raw id is never equal to a golden recorded in another run.
//
// The fake Cursor backend therefore asks the client for every named blob over the real KV channel (`getBlobArgs`, as
// Cursor's server does), and each served blob is checked raw: sha256 over its bytes, nothing normalized, must equal the
// raw id the request named it by. The root prompt blobs (the model input, JSON text) are also kept as content, so the
// normalized compare sees the prompt itself.
import { createHash } from "node:crypto";

/** The run request fields that name blobs, in observation order. */
export const BLOB_ID_FIELDS = ["rootPromptMessagesJson", "turns"];
/** Fields whose blobs are JSON model input, observed as content as well as by hash. */
const CONTENT_FIELDS = new Set(["rootPromptMessagesJson"]);
export const HASH_MATCH = "sha256-match";
export const NOT_SERVED = "not-served";

/**
 * Every blob id the decoded run request names, raw (the base64 protobuf JSON prints bytes as), in field order.
 * @param {object} decoded `toJson(AgentClientMessageSchema, ...)` of the runRequest frame
 * @returns {Array<{ field: string, index: number, id: string }>}
 */
export function runRequestBlobIds(decoded) {
	const state = decoded?.runRequest?.conversationState ?? {};
	return BLOB_ID_FIELDS.flatMap((field) => (state[field] ?? []).map((id, index) => ({ field, index, id })));
}

/** A JSON blob as its parsed value; anything else as its UTF-8 text. */
function blobContent(bytes) {
	const text = Buffer.from(bytes).toString("utf8");
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * The raw-hash verdict for each named blob, plus the content of each root prompt blob.
 * @param {Array<{ field: string, index: number, id: string }>} named
 * @param {Map<string, Uint8Array>} served raw id -> the bytes the client served for it (empty when it had none)
 */
export function blobObservation(named, served) {
	return named.map(({ field, index, id }) => {
		const bytes = served.get(id);
		if (!bytes || bytes.length === 0) return { field, index, hash: NOT_SERVED };
		const digest = createHash("sha256").update(bytes).digest();
		const hash = Buffer.from(id, "base64").equals(digest)
			? HASH_MATCH
			: `mismatch: sha256(blob)=${digest.toString("base64")}`;
		return CONTENT_FIELDS.has(field) ? { field, index, hash, content: blobContent(bytes) } : { field, index, hash };
	});
}

/**
 * Fetch every blob the run request names from the client over `getBlobArgs`, one at a time, and return its
 * blobObservation. `server` is the fake backend (run-server.mjs) with a decoding summarizeClient (`entry.decoded`).
 */
export async function fetchRunRequestBlobs(server, wire, { timeoutMs = 30_000 } = {}) {
	await server.waitForRun(timeoutMs);
	const request = await server.waitFor((e) => e.case === "runRequest", timeoutMs, "runRequest");
	const named = runRequestBlobIds(request.decoded);
	const served = new Map();
	let kvId = 0;
	for (const { id } of named) {
		if (served.has(id)) continue;
		// proto3 JSON omits a zero id, so KV ids start at 1.
		kvId += 1;
		const want = kvId;
		await server.send(wire.kvGetBlobFrame({ id: want, blobId: Buffer.from(id, "base64") }));
		const reply = await server.waitFor(
			(e) => e.case === "kvClientMessage" && e.decoded?.kvClientMessage?.id === want,
			timeoutMs,
			`getBlobResult{id:${want}}`,
		);
		const data = reply.decoded.kvClientMessage.getBlobResult?.blobData;
		served.set(id, data ? Buffer.from(data, "base64") : new Uint8Array());
	}
	return blobObservation(named, served);
}
