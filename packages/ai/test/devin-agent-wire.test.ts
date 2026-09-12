import { create, type DescMessage, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	MetadataSchema,
} from "../src/api/devin-agent/gen/cascade_pb.ts";
import {
	buildDevinChatRequest,
	DEVIN_ASSIGN_MODEL_PATH,
	DEVIN_CHAT_MESSAGE_PATH,
	DEVIN_CLI_MODEL_CONFIGS_PATH,
	DEVIN_USER_JWT_PATH,
	decodeDevinFrames,
	devinCliMetadata,
	devinDiscoveryMetadata,
	encodeDevinRequestFrame,
	normalizeDevinSessionToken,
	readDevinTrailerError,
} from "../src/api/devin-agent/wire.ts";
import type { Context, Model } from "../src/types.ts";

const MODEL: Model<"devin-agent"> = {
	id: "swe-1-6",
	name: "SWE-1.6",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 128_000,
} as unknown as Model<"devin-agent">;

const CONTEXT: Context = {
	systemPrompt: "You are senpi.\n\nBe precise.",
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
} as Context;

/** Locates one length-delimited protobuf field by tag in an encoded message; undefined when absent. */
function findStringField(bytes: Uint8Array, fieldNumber: number): string | undefined {
	let offset = 0;
	const readVarint = (): number => {
		let value = 0;
		let shift = 0;
		for (;;) {
			const byte = bytes[offset++];
			if (byte === undefined) throw new Error("truncated varint");
			value |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7;
		}
	};
	while (offset < bytes.byteLength) {
		const tag = readVarint();
		const wireType = tag & 0x7;
		const number = tag >>> 3;
		if (wireType === 0) {
			readVarint();
		} else if (wireType === 2) {
			const length = readVarint();
			const slice = bytes.subarray(offset, offset + length);
			offset += length;
			if (number === fieldNumber) return new TextDecoder().decode(slice);
		} else if (wireType === 1) {
			offset += 8;
		} else if (wireType === 5) {
			offset += 4;
		} else {
			throw new Error(`unexpected wire type ${wireType}`);
		}
	}
	return undefined;
}

describe("devin-agent wire", () => {
	it("pins the Cascade RPC paths the released CLI calls", () => {
		expect(DEVIN_CHAT_MESSAGE_PATH).toBe("/exa.api_server_pb.ApiServerService/GetChatMessage");
		expect(DEVIN_CLI_MODEL_CONFIGS_PATH).toBe("/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
		expect(DEVIN_USER_JWT_PATH).toBe("/exa.auth_pb.AuthService/GetUserJwt");
		expect(DEVIN_ASSIGN_MODEL_PATH).toBe("/exa.api_server_pb.ApiServerService/AssignModel");
	});

	it("prefixes the session token exactly once", () => {
		expect(normalizeDevinSessionToken("abc")).toBe("devin-session-token$abc");
		expect(normalizeDevinSessionToken("devin-session-token$abc")).toBe("devin-session-token$abc");
		expect(normalizeDevinSessionToken(undefined)).toBe("");
	});

	it("carries the released Devin CLI identity and the prefixed token in chat Metadata", () => {
		const metadata = devinCliMetadata("abc", "jwt-1");
		expect(metadata).toMatchObject({
			apiKey: "devin-session-token$abc",
			userJwt: "jwt-1",
			ideName: "devin-cli",
			ideType: "chisel",
			ideVersion: "3000.6.2",
			extensionName: "chisel",
			extensionVersion: "3000.6.2",
			locale: "en",
		});
		expect(["darwin", "linux", "windows"]).toContain(metadata.os);
		expect(devinCliMetadata("abc").userJwt).toBe("");
	});

	it("encodes the user JWT on Metadata field 21, never on 22 (force_team_id)", () => {
		const bytes = toBinary(MetadataSchema, devinCliMetadata("abc", "jwt-1"));
		expect(findStringField(bytes, 21)).toBe("jwt-1");
		expect(findStringField(bytes, 22)).toBeUndefined();
	});

	it("announces the dev-channel chisel identity with the native display slots for discovery", () => {
		const metadata = devinDiscoveryMetadata("abc");
		expect(metadata).toMatchObject({
			apiKey: "devin-session-token$abc",
			ideName: "chisel",
			ideVersion: "0.0.0-dev",
			extensionName: "chisel",
			extensionVersion: "0.0.0-dev",
			locale: "en",
		});
		expect(metadata.ideType).toBe("");
		expect(metadata.supportedModelDisplays).toEqual([3, 4, 6, 7, 8]);
	});

	it("frames a request as one gzipped Connect frame", async () => {
		const request = buildDevinChatRequest({ model: MODEL, context: CONTEXT, apiKey: "abc", cascadeId: "c" });
		const frame = encodeDevinRequestFrame(GetChatMessageRequestSchema, request);

		expect(frame[0]).toBe(0x01);
		const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
		expect(length).toBe(frame.byteLength - 5);

		const decoded = await collect(decodeDevinFrames(oneShot(frame), GetChatMessageRequestSchema));
		expect(decoded[0]?.message?.prompt).toBe("You are senpi.\n\nBe precise.");
	});

	it("decodes a streamed response and surfaces the end-of-stream trailer", async () => {
		const first = frameOf(GetChatMessageResponseSchema, { messageId: "m1", deltaText: "he" });
		const second = frameOf(GetChatMessageResponseSchema, { messageId: "m1", deltaText: "llo", stopReason: 10 });
		const trailer = trailerFrame('{"metadata":{}}');

		const decoded = await collect(
			decodeDevinFrames(oneShot(concat(first, second, trailer)), GetChatMessageResponseSchema),
		);
		expect(decoded.map((entry) => entry.message?.deltaText)).toEqual(["he", "llo", undefined]);
		expect(decoded.at(-1)?.trailer).toBe('{"metadata":{}}');
	});

	it("reads a Connect error trailer and ignores a clean one", () => {
		expect(readDevinTrailerError('{"metadata":{}}')).toBeUndefined();
		expect(readDevinTrailerError("")).toBeUndefined();
		expect(readDevinTrailerError("not json")).toBeUndefined();
		const error = readDevinTrailerError(
			'{"error":{"code":"invalid_argument","message":"an internal error occurred","details":[{"type":"t","debug":{"x":1}}]}}',
		);
		expect(error).toMatchObject({ code: "invalid_argument", message: "an internal error occurred" });
		expect(error?.formatted).toMatch(/invalid_argument/);
		expect(error?.formatted).toMatch(/an internal error occurred/);
		expect(error?.formatted).toMatch(/t: \{"x":1\}/);
	});

	it("rejects a frame whose length prefix exceeds the payload cap", async () => {
		const bogus = new Uint8Array(5);
		new DataView(bogus.buffer).setUint32(1, 0xffffffff, false);
		await expect(collect(decodeDevinFrames(oneShot(bogus), GetChatMessageResponseSchema))).rejects.toThrow(
			/cap|exceeds/i,
		);
	});
});

function oneShot(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function frameOf<TSchema extends DescMessage>(schema: TSchema, value: MessageInitShape<TSchema>): Uint8Array {
	const payload = toBinary(schema, create(schema, value));
	const frame = new Uint8Array(5 + payload.byteLength);
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
}

function trailerFrame(json: string): Uint8Array {
	const payload = new TextEncoder().encode(json);
	const frame = new Uint8Array(5 + payload.byteLength);
	frame[0] = 0x02;
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}
