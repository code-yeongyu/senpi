/**
 * Cursor Connect/protobuf AgentRun transport.
 *
 * Cursor's account API is not OpenAI chat-completions. Model requests go to
 * `aiserver.v1.ChatService/StreamUnifiedChatWithTools` over HTTP/2 with
 * `application/connect+proto` envelopes (Connect protocol v1).
 *
 * This module implements the minimum request/response path needed for text
 * streaming. The wire layout mirrors the public reverse-engineered client
 * shape used by Cursor CLI/IDE clients (checksum headers + Connect frames).
 */

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { buildBaseOptions } from "./simple-options.ts";

const CHAT_PATH = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools";
const CLIENT_VERSION = "2.3.41";

function randomUUID(): string {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256HexSyncFallback(input: string): string {
	// FNV-1a 64-bit x2 — only used if SubtleCrypto is unavailable (should not happen in modern runtimes).
	let h1 = 0xcbf29ce484222325n;
	let h2 = 0x100000001b3n;
	for (let i = 0; i < input.length; i++) {
		const c = BigInt(input.charCodeAt(i));
		h1 ^= c;
		h1 = BigInt.asUintN(64, h1 * 0x100000001b3n);
		h2 ^= c << 1n;
		h2 = BigInt.asUintN(64, h2 * 0x100000001b3n);
	}
	return (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).padEnd(64, "0");
}

async function sha256Hex(input: string, salt = ""): Promise<string> {
	const data = new TextEncoder().encode(input + salt);
	if (globalThis.crypto?.subtle) {
		const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}
	return sha256HexSyncFallback(input + salt);
}

async function gzipBytes(payload: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "undefined") return payload;
	const copy = new Uint8Array(payload.byteLength);
	copy.set(payload);
	const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(payload: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === "undefined") return payload;
	try {
		const copy = new Uint8Array(payload.byteLength);
		copy.set(payload);
		const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch {
		return payload;
	}
}

export interface CursorConnectOptions extends StreamOptions {}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function obfuscateBytes(bytes: Uint8Array): Uint8Array {
	let t = 165;
	const out = new Uint8Array(bytes);
	for (let i = 0; i < out.length; i++) {
		out[i] = ((out[i] ^ t) + (i % 256)) & 0xff;
		t = out[i];
	}
	return out;
}

/** Cursor client checksum: timestamp obfuscation + machine ids derived from token. */
export async function generateCursorChecksum(token: string): Promise<string> {
	const machineId = await sha256Hex(token, "machineId");
	const macMachineId = await sha256Hex(token, "macMachineId");
	const timestamp = Math.floor(Date.now() / 1e6);
	const byteArray = new Uint8Array([
		(timestamp >> 40) & 255,
		(timestamp >> 32) & 255,
		(timestamp >> 24) & 255,
		(timestamp >> 16) & 255,
		(timestamp >> 8) & 255,
		timestamp & 255,
	]);
	const encoded = Buffer.from(obfuscateBytes(byteArray)).toString("base64");
	return `${encoded}${machineId}/${macMachineId}`;
}

function writeVarint(value: number, out: number[]): void {
	let v = value >>> 0;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v);
}

function encodeTag(fieldNumber: number, wireType: number, out: number[]): void {
	writeVarint((fieldNumber << 3) | wireType, out);
}

function encodeString(fieldNumber: number, value: string, out: number[]): void {
	const bytes = Buffer.from(value, "utf8");
	encodeTag(fieldNumber, 2, out);
	writeVarint(bytes.length, out);
	for (const b of bytes) out.push(b);
}

function encodeBytes(fieldNumber: number, bytes: Uint8Array, out: number[]): void {
	encodeTag(fieldNumber, 2, out);
	writeVarint(bytes.length, out);
	for (const b of bytes) out.push(b);
}

function encodeVarintField(fieldNumber: number, value: number, out: number[]): void {
	encodeTag(fieldNumber, 0, out);
	writeVarint(value, out);
}

function encodeMessage(fieldNumber: number, message: number[], out: number[]): void {
	encodeBytes(fieldNumber, Uint8Array.from(message), out);
}

function encodeChatMessage(role: "user" | "assistant", content: string, messageId: string): number[] {
	const out: number[] = [];
	encodeString(1, content, out); // content
	encodeVarintField(2, role === "user" ? 1 : 2, out); // role
	encodeString(13, messageId, out); // messageId (field numbers match public client layouts)
	if (role === "user") encodeVarintField(47, 1, out); // chatModeEnum
	return out;
}

/**
 * Encode StreamUnifiedChatWithToolsRequest protobuf body.
 * Field numbers follow the public reverse-engineered Cursor client layout.
 */
export function encodeCursorChatRequest(input: {
	model: string;
	system: string;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	conversationId: string;
}): Uint8Array {
	const formatted = input.messages.map((msg) => ({
		...msg,
		messageId: randomUUID(),
	}));
	const request: number[] = [];
	for (const msg of formatted) {
		encodeMessage(1, encodeChatMessage(msg.role, msg.content, msg.messageId), request);
	}
	encodeVarintField(2, 1, request); // unknown2
	const instruction: number[] = [];
	encodeString(1, input.system, instruction);
	encodeMessage(3, instruction, request);
	encodeVarintField(4, 1, request);
	const modelMsg: number[] = [];
	encodeString(1, input.model, modelMsg);
	encodeString(2, "", modelMsg);
	encodeMessage(5, modelMsg, request);
	encodeString(8, "", request); // webTool
	encodeVarintField(13, 1, request);
	const cursorSetting: number[] = [];
	encodeString(1, "cursor\\aisettings", cursorSetting);
	encodeString(3, "", cursorSetting);
	encodeVarintField(8, 1, cursorSetting);
	encodeVarintField(9, 1, cursorSetting);
	encodeMessage(15, cursorSetting, request);
	encodeVarintField(19, 1, request);
	encodeString(23, input.conversationId, request);
	const metadata: number[] = [];
	encodeString(1, "web", metadata);
	encodeString(2, "wasm", metadata);
	encodeString(3, "browser", metadata);
	encodeString(5, new Date().toISOString(), metadata);
	encodeMessage(26, metadata, request);
	encodeVarintField(27, 0, request);
	for (const msg of formatted) {
		const idMsg: number[] = [];
		encodeVarintField(1, msg.role === "user" ? 1 : 2, idMsg);
		encodeString(2, msg.messageId, idMsg);
		encodeMessage(30, idMsg, request);
	}
	encodeVarintField(35, 0, request); // largeContext
	encodeVarintField(38, 0, request);
	encodeVarintField(46, 1, request); // chatModeEnum
	encodeString(47, "", request);
	encodeVarintField(48, 0, request);
	encodeVarintField(49, 0, request);
	encodeVarintField(51, 0, request);
	encodeVarintField(53, 1, request);
	encodeString(54, "Ask", request);

	const root: number[] = [];
	encodeMessage(1, request, root); // StreamUnifiedChatWithToolsRequest.request
	return Uint8Array.from(root);
}

/** Wrap protobuf bytes in a Connect unary/stream request envelope. */
export async function encodeConnectFrame(payload: Uint8Array, gzip = false): Promise<Uint8Array> {
	const body = gzip ? await gzipBytes(payload) : payload;
	const usedGzip = gzip && body !== payload && body.length > 0;
	const frame = new Uint8Array(5 + body.length);
	frame[0] = usedGzip ? 0x01 : 0x00;
	const view = new DataView(frame.buffer);
	view.setUint32(1, body.length, false);
	frame.set(body, 5);
	return frame;
}

function extractUtf8Strings(bytes: Uint8Array): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < bytes.length) {
		const tag = bytes[i++];
		if (tag === undefined) break;
		const wireType = tag & 0x07;
		if (wireType === 0) {
			// varint
			while (i < bytes.length && (bytes[i]! & 0x80) !== 0) i++;
			i++;
		} else if (wireType === 1) {
			i += 8;
		} else if (wireType === 5) {
			i += 4;
		} else if (wireType === 2) {
			let len = 0;
			let shift = 0;
			while (i < bytes.length) {
				const b = bytes[i++]!;
				len |= (b & 0x7f) << shift;
				if ((b & 0x80) === 0) break;
				shift += 7;
			}
			const slice = bytes.subarray(i, i + len);
			i += len;
			// Prefer UTF-8 text-looking length-delimited fields.
			try {
				const text = Buffer.from(slice).toString("utf8");
				if (text && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) && /[\p{L}\p{N}]/u.test(text)) {
					// Skip obvious non-content ids
					if (text.length <= 64 && /^[0-9a-f-]{8,}$/i.test(text)) continue;
					if (text.includes("cursor\\") || text === "Ask") continue;
					out.push(text);
				}
			} catch {
				// ignore
			}
		} else {
			break;
		}
	}
	return out;
}

export async function* parseConnectResponse(
	body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<{ thinking: string; text: string }> {
	if (!body) return;
	const reader = body.getReader();
	let buffer = new Uint8Array(0);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.length) continue;
			const next = new Uint8Array(buffer.length + value.length);
			next.set(buffer);
			next.set(value, buffer.length);
			buffer = next;

			while (buffer.length >= 5) {
				const flags = buffer[0]!;
				const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false);
				if (buffer.length < 5 + length) break;
				let payload = buffer.subarray(5, 5 + length);
				buffer = buffer.subarray(5 + length);
				if ((flags & 0x01) !== 0) {
					const inflated = await gunzipBytes(payload);
					payload = new Uint8Array(inflated);
				}
				if ((flags & 0x02) !== 0) {
					// end-stream JSON trailer
					continue;
				}
				const strings = extractUtf8Strings(payload);
				if (strings.length === 0) continue;
				// Heuristic: last non-empty string is usually the text delta chunk.
				const text = strings[strings.length - 1] ?? "";
				const thinking = strings.length > 1 ? (strings[0] ?? "") : "";
				if (text || thinking) yield { thinking, text };
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function contextToCursorMessages(context: Context): {
	system: string;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
	const systemParts: string[] = [];
	const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
	if (typeof context.systemPrompt === "string" && context.systemPrompt) {
		systemParts.push(context.systemPrompt);
	}
	for (const message of context.messages) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part): part is TextContent => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			if (text) messages.push({ role: "user", content: text });
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) messages.push({ role: "assistant", content: text });
		}
	}
	return { system: systemParts.join("\n"), messages };
}

async function cursorFetch(
	url: string,
	headers: Record<string, string>,
	body: Uint8Array,
	signal?: AbortSignal,
): Promise<Response> {
	// Ambient fetch is stub-friendly in tests. Copy into a fresh ArrayBuffer-backed
	// Uint8Array so RequestInit body typing accepts it under DOM lib checks.
	const copy = new Uint8Array(body.byteLength);
	copy.set(body);
	return await globalThis.fetch(url, {
		method: "POST",
		headers,
		body: copy,
		signal,
	});
}

export const streamCursorConnect: (
	model: Model<"cursor-connect">,
	context: Context,
	options?: CursorConnectOptions,
) => AssistantMessageEventStream = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	const output = createMessage(model);

	(async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("Cursor Connect requires an API key / access token");
			const baseUrl = (model.baseUrl || "https://api2.cursor.sh").replace(/\/$/, "");
			const { system, messages } = contextToCursorMessages(context);
			if (messages.length === 0) throw new Error("Cursor Connect requires at least one user message");

			const proto = encodeCursorChatRequest({
				model: model.id === "default" ? "default" : model.id,
				system,
				messages,
				conversationId: randomUUID(),
			});
			const body = await encodeConnectFrame(proto, messages.length >= 3);
			const checksum = await generateCursorChecksum(apiKey);
			const headers: Record<string, string> = {
				authorization: `Bearer ${apiKey}`,
				"connect-protocol-version": "1",
				"content-type": "application/connect+proto",
				"connect-accept-encoding": "gzip",
				"user-agent": "connect-es/1.6.1",
				"x-cursor-checksum": checksum,
				"x-cursor-client-version": CLIENT_VERSION,
				"x-cursor-config-version": randomUUID(),
				"x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
				"x-ghost-mode": "true",
				"x-request-id": randomUUID(),
				"x-session-id": randomUUID(),
				"x-client-key": await sha256Hex(apiKey),
				...(options?.headers ?? {}),
			};

			stream.push({ type: "start", partial: output });
			const response = await cursorFetch(`${baseUrl}${CHAT_PATH}`, headers, body, options?.signal);
			if (!response.ok) {
				const errText = await response.text().catch(() => response.statusText);
				throw new Error(`Cursor Connect request failed (${response.status}): ${errText.slice(0, 200)}`);
			}

			let contentIndex = -1;
			let text = "";
			for await (const chunk of parseConnectResponse(response.body)) {
				if (chunk.thinking) {
					// Surface thinking as ordinary text delimiters when present.
					const delta = chunk.thinking;
					if (contentIndex < 0) {
						contentIndex = 0;
						output.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex, partial: output });
					}
					text += delta;
					(output.content[contentIndex] as TextContent).text = text;
					stream.push({ type: "text_delta", contentIndex, delta, partial: output });
				}
				if (chunk.text) {
					if (contentIndex < 0) {
						contentIndex = 0;
						output.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex, partial: output });
					}
					text += chunk.text;
					(output.content[contentIndex] as TextContent).text = text;
					stream.push({ type: "text_delta", contentIndex, delta: chunk.text, partial: output });
				}
			}
			if (contentIndex >= 0) {
				stream.push({
					type: "text_end",
					contentIndex,
					content: (output.content[contentIndex] as TextContent).text,
					partial: output,
				});
			}
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end(output);
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: output.stopReason === "aborted" ? "aborted" : "error",
				error: output,
			});
			stream.end(output);
		}
	})();

	return stream;
};

export const streamSimpleCursorConnect: (
	model: Model<"cursor-connect">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream = (model, context, options) => {
	const base = buildBaseOptions(model, context, options);
	return streamCursorConnect(model, context, base);
};

export const cursorConnectStreams = {
	stream: streamCursorConnect,
	streamSimple: streamSimpleCursorConnect,
};
