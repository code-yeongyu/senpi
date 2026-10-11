import { lazyStream } from "../api/lazy.ts";
import { getEnvApiKey } from "../env-api-keys.ts";
import type { Api, AssistantMessageEventStream, Model, ProviderStreams, StreamOptions } from "../types.ts";

/**
 * Venice E2EE, as documented at
 * https://docs.venice.ai/guides/features/tee-e2ee-models.
 *
 * The client encrypts every prompt before it leaves the process. Venice's
 * relay only forwards ciphertext. The TEE decrypts `user` and `system`
 * messages, so assistant and tool turns are folded into encrypted `user`
 * messages rather than sent in the clear. The response stream is decrypted
 * locally.
 *
 * The signing key is accepted only when the Intel TDX quote's REPORTDATA
 * binds it. Venice's `/tee/attestation` quote uses
 * `address(20) || zeros(12) || nonce(32)`. Quote layout follows Intel's
 * DCAP v4 body (google/go-tdx-guest `abi.go`: header 0x30, TD attributes at
 * body 0x78, REPORTDATA at body 0x208). This checks that binding and rejects
 * a debug TD. It does not DCAP-authenticate the quote signature against
 * Intel's PCK roots.
 */

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const MASK64 = (1n << 64n) - 1n;
const HKDF_INFO = new TextEncoder().encode("ecdsa_encryption");
const QUOTE_HEADER_LEN = 0x30;
const TD_ATTRIBUTES_OFFSET = 0x78;
const TD_REPORT_DATA_OFFSET = 0x208;
const TD_REPORT_DATA_LEN = 0x40;
const TD_QUOTE_BODY_LEN = 0x248;

const KECCAK_RC = [
	0x0000000000000001n,
	0x0000000000008082n,
	0x800000000000808an,
	0x8000000080008000n,
	0x000000000000808bn,
	0x0000000080000001n,
	0x8000000080008081n,
	0x8000000000008009n,
	0x000000000000008an,
	0x0000000000000088n,
	0x0000000080008009n,
	0x000000008000000an,
	0x000000008000808bn,
	0x800000000000008bn,
	0x8000000000008089n,
	0x8000000000008003n,
	0x8000000000008002n,
	0x8000000000000080n,
	0x000000000000800an,
	0x800000008000000an,
	0x8000000080008081n,
	0x8000000000008080n,
	0x0000000080000001n,
	0x8000000080008008n,
] as const;

const KECCAK_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const VENICE_E2EE_COMPAT = {
	veniceParameters: { include_venice_system_prompt: false as const },
};

interface EcPoint {
	x: bigint;
	y: bigint;
}

interface VeniceE2EESession {
	clientPublicKeyHex: string;
	modelPublicKeyHex: string;
	decrypt(ciphertextHex: string): Promise<string>;
	zero(): void;
}

type FetchLike = typeof globalThis.fetch;

export function isVeniceE2EEModelId(id: string): boolean {
	return id.startsWith("e2ee-");
}

/** Catalog rows models.dev does not publish. Prices and context are Venice's published E2EE listing. */
export function veniceE2EEModels(): Model<"openai-completions">[] {
	const row = (
		id: string,
		name: string,
		contextWindow: number,
		maxTokens: number,
		input: number,
		output: number,
	): Model<"openai-completions"> => ({
		id,
		name,
		api: "openai-completions",
		provider: "venice",
		baseUrl: "https://api.venice.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
		compat: { ...VENICE_E2EE_COMPAT },
		contextWindow,
		maxTokens,
	});
	return [
		row("e2ee-glm-5-3-p", "GLM 5.3 E2EE", 1_000_000, 131_072, 1.75, 5.5),
		row("e2ee-glm-5-3-flash", "GLM 5.3 Flash E2EE", 1_000_000, 131_072, 0.16, 0.54),
		row("e2ee-glm-5-2-p", "GLM 5.2 E2EE", 524_288, 131_072, 1.75, 5.75),
		row("e2ee-deepseek-v4-flash", "DeepSeek V4 Flash E2EE", 1_000_000, 32_768, 0.18, 0.37),
		row("e2ee-gpt-oss-120b-p", "GPT OSS 120B E2EE", 128_000, 16_384, 0.13, 0.65),
	];
}

export function withVeniceE2EE(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) =>
			isVeniceE2EEModel(model)
				? streamVeniceE2EE(model, context, options, (session) =>
						streams.stream(model, context, withVeniceE2EEOptions(options, session)),
					)
				: streams.stream(model, context, options),
		streamSimple: (model, context, options) =>
			isVeniceE2EEModel(model)
				? streamVeniceE2EE(model, context, options, (session) =>
						streams.streamSimple(model, context, withVeniceE2EEOptions(options, session)),
					)
				: streams.streamSimple(model, context, options),
	};
}

function isVeniceE2EEModel(model: Model<Api>): boolean {
	return model.provider === "venice" && isVeniceE2EEModelId(model.id);
}

function streamVeniceE2EE(
	model: Model<Api>,
	context: Parameters<ProviderStreams["stream"]>[1],
	options: StreamOptions | undefined,
	open: (session: VeniceE2EESession) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		assertVeniceE2EETextOnly(context.messages);
		const session = await openVeniceE2EESession(model, options);
		try {
			return bindSession(open(session), session);
		} catch (error) {
			session.zero();
			throw error;
		}
	});
}

function assertVeniceE2EETextOnly(messages: readonly { content?: unknown }[]): void {
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part)) continue;
			if (part.type === "image" || part.type === "audio" || part.type === "input_audio") {
				throw new Error("Venice E2EE does not support image or audio input. The attachment was not sent.");
			}
		}
	}
}

function withVeniceE2EEOptions(options: StreamOptions | undefined, session: VeniceE2EESession): StreamOptions {
	const upstreamTransform = options?.onPayload;
	const rawFetch = options?.fetch ?? globalThis.fetch.bind(globalThis);
	return {
		...options,
		headers: {
			...options?.headers,
			"X-Venice-TEE-Client-Pub-Key": session.clientPublicKeyHex,
			"X-Venice-TEE-Model-Pub-Key": session.modelPublicKeyHex,
			"X-Venice-TEE-Signing-Algo": "ecdsa",
		},
		onPayload: async (payload, payloadModel, request) => {
			const transformed = (await upstreamTransform?.(payload, payloadModel, request)) ?? payload;
			return sealVeniceChatPayload(transformed, session.modelPublicKeyHex);
		},
		fetch: decryptingFetch(rawFetch, session),
	};
}

function bindSession(source: AssistantMessageEventStream, session: VeniceE2EESession) {
	const iterator = source[Symbol.asyncIterator]();
	return {
		[Symbol.asyncIterator](): AsyncIterator<Parameters<AssistantMessageEventStream["push"]>[0]> {
			return {
				async next() {
					try {
						const step = await iterator.next();
						if (step.done) session.zero();
						return step;
					} catch (error) {
						session.zero();
						throw error;
					}
				},
				async return(value?: unknown) {
					session.zero();
					if (iterator.return) return iterator.return(value);
					return { done: true as const, value: undefined };
				},
			};
		},
		async result() {
			try {
				return await source.result();
			} finally {
				session.zero();
			}
		},
	};
}

async function openVeniceE2EESession(
	model: Model<Api>,
	options: StreamOptions | undefined,
): Promise<VeniceE2EESession> {
	const apiKey = options?.apiKey ?? getEnvApiKey("venice", options?.env);
	if (!apiKey) throw new Error("Venice E2EE requires a Venice API key.");
	const clientPrivateKey = randomScalar();
	const clientPublicKeyHex = toHex(publicKeyUncompressed(clientPrivateKey));
	const fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
	try {
		const attestation = await fetchAttestation(model, apiKey, fetchImpl, options?.signal);
		const modelPublicKeyHex = normalizePublicKeyHex(attestation.modelPublicKeyHex);
		validatePublicKey(modelPublicKeyHex);
		return {
			clientPublicKeyHex,
			modelPublicKeyHex,
			decrypt: (ciphertextHex) => decryptChunk(ciphertextHex, clientPrivateKey),
			zero: () => {
				clientPrivateKey.fill(0);
			},
		};
	} catch (error) {
		clientPrivateKey.fill(0);
		throw error;
	}
}

interface VerifiedAttestation {
	modelPublicKeyHex: string;
}

async function fetchAttestation(
	model: Model<Api>,
	apiKey: string,
	fetchImpl: FetchLike,
	signal: AbortSignal | undefined,
): Promise<VerifiedAttestation> {
	const nonce = randomBytes(32);
	const nonceHex = toHex(nonce);
	const baseUrl = model.baseUrl.replace(/\/$/, "");
	const url = `${baseUrl}/tee/attestation?model=${encodeURIComponent(model.id)}&nonce=${nonceHex}`;
	const response = await fetchImpl(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		...(signal ? { signal } : {}),
	});
	if (!response.ok) {
		throw new Error(`Venice TEE attestation failed with HTTP ${response.status}.`);
	}
	const body: unknown = await response.json();
	return verifyAttestation(body, model.id, nonce);
}

function verifyAttestation(body: unknown, modelId: string, nonce: Uint8Array): VerifiedAttestation {
	if (!isRecord(body)) throw new Error("Venice TEE attestation was not a JSON object.");
	if (body.verified !== true) throw new Error("Venice TEE attestation was not verified.");
	if (body.nonce !== toHex(nonce)) throw new Error("Venice TEE attestation nonce did not match.");
	if (typeof body.model === "string" && body.model !== modelId) {
		throw new Error("Venice TEE attestation was for a different model.");
	}
	const signingKey = body.signing_key ?? body.signing_public_key;
	if (typeof signingKey !== "string") throw new Error("Venice TEE attestation did not include a signing key.");
	const modelPublicKeyHex = normalizePublicKeyHex(signingKey);
	validatePublicKey(modelPublicKeyHex);
	if (typeof body.intel_quote !== "string" || body.intel_quote.length === 0) {
		throw new Error("Venice TEE attestation did not include an Intel TDX quote.");
	}
	const quote = decodeBase64(body.intel_quote);
	const reportData = reportDataFromQuote(quote);
	const address = ethereumAddress(modelPublicKeyHex);
	if (!bytesEqual(reportData.subarray(0, 20), address)) {
		throw new Error("Venice TEE quote does not bind the signing key.");
	}
	if (!isZero(reportData.subarray(20, 32))) {
		throw new Error("Venice TEE quote REPORTDATA padding was not empty.");
	}
	if (!bytesEqual(reportData.subarray(32, 64), nonce)) {
		throw new Error("Venice TEE quote does not bind this attestation nonce.");
	}
	if (typeof body.signing_address === "string") {
		const claimed = body.signing_address.toLowerCase().replace(/^0x/, "");
		if (claimed !== toHex(address)) throw new Error("Venice TEE signing address does not match the signing key.");
	}
	return { modelPublicKeyHex };
}

function reportDataFromQuote(quote: Uint8Array): Uint8Array {
	if (quote.length < 4) throw new Error("Venice TEE quote is truncated.");
	const version = readU16LE(quote, 0);
	const teeType = readU32LE(quote, 4);
	if (teeType !== 0x81) throw new Error("Venice TEE quote is not an Intel TDX quote.");
	let bodyStart = QUOTE_HEADER_LEN;
	if (version === 5) {
		if (quote.length < QUOTE_HEADER_LEN + 6) throw new Error("Venice TEE quote is truncated.");
		const bodySize = readU32LE(quote, QUOTE_HEADER_LEN + 2);
		if (bodySize < TD_QUOTE_BODY_LEN) throw new Error("Venice TEE quote body is too small.");
		bodyStart = QUOTE_HEADER_LEN + 6;
	} else if (version !== 4) {
		throw new Error(`Venice TEE quote version ${version} is not supported.`);
	}
	const attributesAt = bodyStart + TD_ATTRIBUTES_OFFSET;
	const reportAt = bodyStart + TD_REPORT_DATA_OFFSET;
	if (quote.length < reportAt + TD_REPORT_DATA_LEN) throw new Error("Venice TEE quote is missing REPORTDATA.");
	if ((quote[attributesAt] & 0x01) !== 0) throw new Error("Venice TEE quote is from a debug enclave.");
	return quote.slice(reportAt, reportAt + TD_REPORT_DATA_LEN);
}

async function sealVeniceChatPayload(payload: unknown, modelPublicKeyHex: string): Promise<unknown> {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) {
		throw new Error("Venice E2EE request is missing messages.");
	}
	const messages: Array<{ role: "system" | "user"; content: string }> = [];
	for (const message of payload.messages) {
		const sealed = await sealMessage(message, modelPublicKeyHex);
		if (sealed) messages.push(sealed);
	}
	if (messages.length === 0) throw new Error("Venice E2EE request has no content to encrypt.");
	const previous = isRecord(payload.venice_parameters) ? payload.venice_parameters : {};
	const { tools: _tools, tool_choice: _toolChoice, ...rest } = payload;
	return {
		...rest,
		messages,
		stream: true,
		venice_parameters: {
			...previous,
			include_venice_system_prompt: false,
			enable_web_search: "off",
			enable_web_scraping: false,
			enable_web_citations: false,
			enable_x_search: false,
		},
	};
}

async function sealMessage(
	message: unknown,
	modelPublicKeyHex: string,
): Promise<{ role: "system" | "user"; content: string } | null> {
	if (!isRecord(message) || typeof message.role !== "string") {
		throw new Error("Venice E2EE request has a message without a role.");
	}
	const text = messageText(message);
	if (text === null) return null;
	if (message.role === "system" || message.role === "developer") {
		return { role: "system", content: await encryptMessage(text, modelPublicKeyHex) };
	}
	const plaintext = message.role === "user" ? text : `${message.role}: ${text}`;
	return { role: "user", content: await encryptMessage(plaintext, modelPublicKeyHex) };
}

function messageText(message: Record<string, unknown>): string | null {
	const parts: string[] = [];
	appendContent(parts, message.content);
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (!isRecord(call)) continue;
			const fn = isRecord(call.function) ? call.function : undefined;
			const name = fn && typeof fn.name === "string" ? fn.name : "tool";
			const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
			parts.push(`tool_call ${name}: ${args}`);
		}
	}
	for (const field of ["reasoning", "reasoning_content", "reasoning_text"] as const) {
		const value = message[field];
		if (typeof value === "string" && value.length > 0) parts.push(value);
	}
	if (typeof message.name === "string" && message.role === "tool") {
		parts.unshift(message.name);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

function appendContent(parts: string[], content: unknown): void {
	if (typeof content === "string") {
		if (content.length > 0) parts.push(content);
		return;
	}
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (typeof part === "string") {
			if (part.length > 0) parts.push(part);
			continue;
		}
		if (!isRecord(part)) continue;
		if (part.type === "image_url" || part.type === "image" || part.type === "input_audio") {
			throw new Error("Venice E2EE does not support image or audio input. The attachment was not sent.");
		}
		if (typeof part.text === "string" && part.text.length > 0) parts.push(part.text);
	}
}

function decryptingFetch(fetchImpl: FetchLike, session: VeniceE2EESession): FetchLike {
	return async (input, init) => {
		const response = await fetchImpl(input, init);
		if (!response.ok || !response.body) return response;
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) return decryptJsonResponse(response, session);
		if (contentType.includes("text/event-stream") || contentType.length === 0) {
			return decryptSseResponse(response, session);
		}
		return response;
	};
}

async function decryptJsonResponse(response: Response, session: VeniceE2EESession): Promise<Response> {
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return new Response(text, responseInit(response));
	}
	await decryptContentFields(parsed, session);
	return new Response(JSON.stringify(parsed), responseInit(response));
}

function decryptSseResponse(response: Response, session: VeniceE2EESession): Response {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	const stream = response.body!.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			async transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				const rewritten = await rewriteLines(lines, session);
				if (rewritten.length > 0) controller.enqueue(encoder.encode(`${rewritten.join("\n")}\n`));
			},
			async flush(controller) {
				buffer += decoder.decode();
				if (buffer.length === 0) return;
				const rewritten = await rewriteLines([buffer], session);
				controller.enqueue(encoder.encode(rewritten.join("\n")));
			},
		}),
	);
	return new Response(stream, responseInit(response));
}

async function rewriteLines(lines: string[], session: VeniceE2EESession): Promise<string[]> {
	const out: string[] = [];
	for (const line of lines) out.push(await rewriteSseLine(line, session));
	return out;
}

async function rewriteSseLine(line: string, session: VeniceE2EESession): Promise<string> {
	const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
	const carriage = line.endsWith("\r");
	if (!trimmed.startsWith("data: ")) return line;
	const data = trimmed.slice(6);
	if (data === "[DONE]") return line;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return line;
	}
	await decryptContentFields(parsed, session);
	const rewritten = `data: ${JSON.stringify(parsed)}`;
	return carriage ? `${rewritten}\r` : rewritten;
}

async function decryptContentFields(value: unknown, session: VeniceE2EESession): Promise<void> {
	if (!isRecord(value)) return;
	if (Array.isArray(value.choices)) {
		for (const choice of value.choices) {
			if (!isRecord(choice)) continue;
			await decryptMessageContent(choice.delta, session);
			await decryptMessageContent(choice.message, session);
		}
	}
}

async function decryptMessageContent(message: unknown, session: VeniceE2EESession): Promise<void> {
	if (!isRecord(message)) return;
	for (const field of ["content", "reasoning_content", "refusal"] as const) {
		const current = message[field];
		if (typeof current === "string" && isEncryptedHex(current)) {
			message[field] = await session.decrypt(current);
		}
	}
}

function responseInit(response: Response): ResponseInit {
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return { status: response.status, statusText: response.statusText, headers };
}

async function encryptMessage(plaintext: string, modelPublicKeyHex: string): Promise<string> {
	const ephemeral = randomScalar();
	const shared = sharedSecretX(ephemeral, modelPublicKeyHex);
	try {
		const aesKey = await deriveAesKey(shared);
		try {
			const nonce = randomBytes(12);
			const ciphertext = await aesGcmEncrypt(aesKey, nonce, new TextEncoder().encode(plaintext));
			const out = new Uint8Array(65 + 12 + ciphertext.length);
			out.set(publicKeyUncompressed(ephemeral), 0);
			out.set(nonce, 65);
			out.set(ciphertext, 77);
			return toHex(out);
		} finally {
			aesKey.fill(0);
		}
	} finally {
		ephemeral.fill(0);
		shared.fill(0);
	}
}

async function decryptChunk(ciphertextHex: string, clientPrivateKey: Uint8Array): Promise<string> {
	if (clientPrivateKey.every((byte) => byte === 0)) throw new Error("Venice E2EE session key is already cleared.");
	if (!isEncryptedHex(ciphertextHex)) throw new Error("Venice E2EE response chunk was not ciphertext.");
	const raw = fromHex(ciphertextHex);
	if (raw[0] !== 0x04) throw new Error("Venice E2EE response has an invalid ephemeral public key.");
	const serverPublic = toHex(raw.subarray(0, 65));
	const nonce = raw.subarray(65, 77);
	const ciphertext = raw.subarray(77);
	const shared = sharedSecretX(clientPrivateKey, serverPublic);
	try {
		const aesKey = await deriveAesKey(shared);
		try {
			const plaintext = await aesGcmDecrypt(aesKey, nonce, ciphertext);
			return new TextDecoder().decode(plaintext);
		} finally {
			aesKey.fill(0);
		}
	} finally {
		shared.fill(0);
	}
}

async function deriveAesKey(shared: Uint8Array): Promise<Uint8Array> {
	const ikm = await globalThis.crypto.subtle.importKey("raw", bytesToArrayBuffer(shared), "HKDF", false, [
		"deriveBits",
	]);
	const bits = await globalThis.crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: bytesToArrayBuffer(new Uint8Array(32)),
			info: bytesToArrayBuffer(HKDF_INFO),
		},
		ikm,
		256,
	);
	return new Uint8Array(bits);
}

async function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await globalThis.crypto.subtle.importKey("raw", bytesToArrayBuffer(key), "AES-GCM", false, [
		"encrypt",
	]);
	const encrypted = await globalThis.crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: bytesToArrayBuffer(nonce) },
		cryptoKey,
		bytesToArrayBuffer(plaintext),
	);
	return new Uint8Array(encrypted);
}

async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await globalThis.crypto.subtle.importKey("raw", bytesToArrayBuffer(key), "AES-GCM", false, [
		"decrypt",
	]);
	try {
		const plaintext = await globalThis.crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytesToArrayBuffer(nonce) },
			cryptoKey,
			bytesToArrayBuffer(ciphertext),
		);
		return new Uint8Array(plaintext);
	} catch {
		throw new Error("Venice E2EE response could not be decrypted.");
	}
}

function sharedSecretX(privateKey: Uint8Array, theirPublicKeyHex: string): Uint8Array {
	const point = decodePublicKey(theirPublicKeyHex);
	const shared = scalarMultiply(bytesToBigInt(privateKey), point);
	if (!shared) throw new Error("Venice E2EE shared secret was empty.");
	return bigIntToBytes(shared.x, 32);
}

function publicKeyUncompressed(privateKey: Uint8Array): Uint8Array {
	const point = scalarMultiply(bytesToBigInt(privateKey), { x: GX, y: GY });
	if (!point) throw new Error("Venice E2EE public key was empty.");
	const out = new Uint8Array(65);
	out[0] = 0x04;
	out.set(bigIntToBytes(point.x, 32), 1);
	out.set(bigIntToBytes(point.y, 32), 33);
	return out;
}

function validatePublicKey(publicKeyHex: string): void {
	decodePublicKey(publicKeyHex);
}

function normalizePublicKeyHex(value: string): string {
	const hex = value.startsWith("0x") ? value.slice(2) : value;
	if (hex.length === 128) return `04${hex.toLowerCase()}`;
	return hex.toLowerCase();
}

function decodePublicKey(publicKeyHex: string): EcPoint {
	const normalized = normalizePublicKeyHex(publicKeyHex);
	if (normalized.length !== 130 || !normalized.startsWith("04") || !/^[0-9a-f]+$/.test(normalized)) {
		throw new Error("Venice E2EE public key must be 65 uncompressed bytes.");
	}
	const bytes = fromHex(normalized);
	const point = { x: bytesToBigInt(bytes.subarray(1, 33)), y: bytesToBigInt(bytes.subarray(33, 65)) };
	if (!isOnCurve(point)) throw new Error("Venice E2EE public key is not on secp256k1.");
	return point;
}

function isOnCurve(point: EcPoint): boolean {
	const y2 = mod(point.y * point.y);
	const x3 = mod(point.x * point.x * point.x + 7n);
	return y2 === x3;
}

function scalarMultiply(scalar: bigint, point: EcPoint): EcPoint | null {
	let result: EcPoint | null = null;
	let addend: EcPoint | null = point;
	let k = scalar % N;
	while (k > 0n) {
		if ((k & 1n) === 1n) result = pointAdd(result, addend);
		addend = pointAdd(addend, addend);
		k >>= 1n;
	}
	return result;
}

function pointAdd(p: EcPoint | null, q: EcPoint | null): EcPoint | null {
	if (!p) return q;
	if (!q) return p;
	if (p.x === q.x) {
		if (mod(p.y + q.y) === 0n) return null;
		const slope = mod(3n * p.x * p.x * invert(mod(2n * p.y)));
		const x = mod(slope * slope - 2n * p.x);
		const y = mod(slope * (p.x - x) - p.y);
		return { x, y };
	}
	const slope = mod((q.y - p.y) * invert(mod(q.x - p.x)));
	const x = mod(slope * slope - p.x - q.x);
	const y = mod(slope * (p.x - x) - p.y);
	return { x, y };
}

function ethereumAddress(publicKeyHex: string): Uint8Array {
	const normalized = normalizePublicKeyHex(publicKeyHex);
	const hash = keccak256(fromHex(normalized).subarray(1));
	return hash.subarray(12);
}

function keccak256(input: Uint8Array): Uint8Array {
	const rate = 136;
	const state = new Array<bigint>(25).fill(0n);
	const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate || rate);
	padded.set(input);
	padded[input.length] ^= 0x01;
	padded[padded.length - 1] ^= 0x80;
	for (let offset = 0; offset < padded.length; offset += rate) {
		for (let lane = 0; lane < rate / 8; lane++) {
			state[lane] = (state[lane] ^ readLane(padded, offset + lane * 8)) & MASK64;
		}
		keccakF(state);
	}
	const out = new Uint8Array(32);
	for (let lane = 0; lane < 4; lane++) writeLane(out, lane * 8, state[lane]);
	return out;
}

function keccakF(state: bigint[]): void {
	const bc = new Array<bigint>(5);
	for (let round = 0; round < 24; round++) {
		for (let x = 0; x < 5; x++) {
			bc[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
		}
		for (let x = 0; x < 5; x++) {
			const t = (bc[(x + 4) % 5] ^ rotl64(bc[(x + 1) % 5], 1)) & MASK64;
			for (let y = 0; y < 25; y += 5) state[y + x] = (state[y + x] ^ t) & MASK64;
		}
		let t = state[1];
		for (let i = 0; i < 24; i++) {
			const j = KECCAK_PILN[i];
			const tmp = state[j];
			state[j] = rotl64(t, KECCAK_ROTC[i]);
			t = tmp;
		}
		for (let y = 0; y < 25; y += 5) {
			const row = state.slice(y, y + 5);
			for (let x = 0; x < 5; x++) {
				state[y + x] = (row[x] ^ (~row[(x + 1) % 5] & row[(x + 2) % 5])) & MASK64;
			}
		}
		state[0] = (state[0] ^ KECCAK_RC[round]) & MASK64;
	}
}

function rotl64(value: bigint, bits: number): bigint {
	const shift = BigInt(bits);
	return ((value << shift) | (value >> (64n - shift))) & MASK64;
}

function readLane(bytes: Uint8Array, offset: number): bigint {
	let value = 0n;
	for (let i = 0; i < 8; i++) value |= BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i);
	return value;
}

function writeLane(bytes: Uint8Array, offset: number, lane: bigint): void {
	for (let i = 0; i < 8 && offset + i < bytes.length; i++) {
		bytes[offset + i] = Number((lane >> BigInt(8 * i)) & 0xffn);
	}
}

function randomScalar(): Uint8Array {
	for (;;) {
		const bytes = randomBytes(32);
		const scalar = bytesToBigInt(bytes);
		if (scalar > 0n && scalar < N) return bytes;
	}
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
	const out = new Uint8Array(length);
	let remaining = value;
	for (let i = length - 1; i >= 0; i--) {
		out[i] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return out;
}

function mod(value: bigint): bigint {
	const reduced = value % P;
	return reduced >= 0n ? reduced : reduced + P;
}

function invert(value: bigint): bigint {
	return modPow(value, P - 2n);
}

function modPow(base: bigint, exponent: bigint): bigint {
	let result = 1n;
	let b = mod(base);
	let e = exponent;
	while (e > 0n) {
		if ((e & 1n) === 1n) result = mod(result * b);
		b = mod(b * b);
		e >>= 1n;
	}
	return result;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function toHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function fromHex(hex: string): Uint8Array {
	const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
	if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
		throw new Error("Venice E2EE value was not hex.");
	}
	const out = new Uint8Array(normalized.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function isEncryptedHex(value: string): boolean {
	return value.length >= 186 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function decodeBase64(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
	const binary = atob(normalized);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
	return diff === 0;
}

function isZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
