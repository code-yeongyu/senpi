import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const BRIDGE_FRAME_MAX_BYTES = 10 * 1024 * 1024;

const bridgeErrorSchema = Type.Object({
	name: Type.Optional(Type.String()),
	message: Type.String(),
	stack: Type.Optional(Type.String()),
	code: Type.Optional(Type.String()),
});

const connectionConfigSchema = Type.Object({
	port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	token: Type.String({ minLength: 1 }),
});

const hostToKernelMessageSchema = Type.Union([
	Type.Object({
		type: Type.Literal("init"),
		sessionId: Type.String({ minLength: 1 }),
		connection: connectionConfigSchema,
	}),
	Type.Object({
		type: Type.Literal("run"),
		cellId: Type.String({ minLength: 1 }),
		code: Type.String(),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	Type.Object({
		type: Type.Literal("tool-reply"),
		callId: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		value: Type.Unknown(),
	}),
	Type.Object({
		type: Type.Literal("tool-reply"),
		callId: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: bridgeErrorSchema,
	}),
	Type.Object({
		type: Type.Literal("interrupt"),
		reason: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("close"),
	}),
]);

const kernelToHostMessageSchema = Type.Union([
	Type.Object({ type: Type.Literal("ready") }),
	Type.Object({ type: Type.Literal("init-failed"), error: bridgeErrorSchema }),
	Type.Object({
		type: Type.Literal("text"),
		stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
		data: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("display"),
		mimeType: Type.String({ minLength: 1 }),
		dataBase64: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("tool-call"),
		callId: Type.String({ minLength: 1 }),
		toolName: Type.String({ minLength: 1 }),
		args: Type.Unknown(),
	}),
	Type.Object({ type: Type.Literal("log"), message: Type.String() }),
	Type.Object({ type: Type.Literal("phase"), title: Type.String() }),
	Type.Object({
		type: Type.Literal("result"),
		cellId: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		valueRepr: Type.Optional(Type.String()),
		durationMs: Type.Integer({ minimum: 0 }),
	}),
	Type.Object({
		type: Type.Literal("result"),
		cellId: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: bridgeErrorSchema,
		durationMs: Type.Integer({ minimum: 0 }),
	}),
	Type.Object({ type: Type.Literal("closed") }),
]);

const bridgeMessageSchema = Type.Union([hostToKernelMessageSchema, kernelToHostMessageSchema]);

export type BridgeError = Static<typeof bridgeErrorSchema>;
export type BridgeConnectionConfig = Static<typeof connectionConfigSchema>;
export type HostToKernelMessage = Static<typeof hostToKernelMessageSchema>;
export type KernelToHostMessage = Static<typeof kernelToHostMessageSchema>;
export type BridgeMessage = Static<typeof bridgeMessageSchema>;

export type BridgeDecodeErrorCode =
	| "empty_frame"
	| "frame_too_large"
	| "multiple_frames"
	| "malformed_json"
	| "invalid_message";

export interface BridgeDecodeError {
	code: BridgeDecodeErrorCode;
	message: string;
}

export type BridgeDecodeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeDecodeError };
export type BridgeMessageDecodeResult = { ok: true; message: BridgeMessage } | { ok: false; error: BridgeDecodeError };

export type BridgeActivityReply =
	| { state: "active"; sessionId: string }
	| { state: "inactive"; sessionId?: string }
	| { state: "blocked"; reason: string }
	| { state: "error"; error: BridgeError };

export type BridgeTokenVerifyResult = { ok: true } | { ok: false; error: { code: "token_mismatch"; message: string } };

export interface BridgeFrameOptions {
	maxBytes?: number;
}

export function generateCorrelationId(): string {
	return randomUUID();
}

export function generateBridgeToken(byteLength = 32): string {
	return randomBytes(byteLength).toString("base64url");
}

export function verifyBridgeToken(expected: string, received: string): BridgeTokenVerifyResult {
	const expectedHash = tokenHash(expected);
	const receivedHash = tokenHash(received);
	if (timingSafeEqual(expectedHash, receivedHash)) return { ok: true };
	return { ok: false, error: { code: "token_mismatch", message: "Bridge bearer token did not match" } };
}

export function encodeBridgeFrame(message: BridgeMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseBridgeJsonLine(line: string, options: BridgeFrameOptions = {}): BridgeDecodeResult<unknown> {
	const maxBytes = options.maxBytes ?? BRIDGE_FRAME_MAX_BYTES;
	const byteLength = Buffer.byteLength(line, "utf8");
	if (byteLength > maxBytes) {
		return { ok: false, error: { code: "frame_too_large", message: `Bridge frame exceeds ${maxBytes} bytes` } };
	}
	const trimmedLine = line.endsWith("\n") ? line.slice(0, -1) : line;
	if (trimmedLine.length === 0) {
		return { ok: false, error: { code: "empty_frame", message: "Bridge frame was empty" } };
	}
	if (trimmedLine.includes("\n")) {
		return {
			ok: false,
			error: { code: "multiple_frames", message: "Bridge frame contained more than one LF record" },
		};
	}
	try {
		return { ok: true, value: JSON.parse(trimmedLine) as unknown };
	} catch (error) {
		return { ok: false, error: { code: "malformed_json", message: errorMessage(error) } };
	}
}

export function decodeBridgeFrame(line: string, options: BridgeFrameOptions = {}): BridgeMessageDecodeResult {
	const parsed = parseBridgeJsonLine(line, options);
	if (!parsed.ok) return parsed;
	if (Value.Check(bridgeMessageSchema, parsed.value)) {
		return { ok: true, message: parsed.value };
	}
	const firstError = Value.Errors(bridgeMessageSchema, parsed.value)[0];
	const message = firstError ? `Invalid bridge message: ${firstError.message}` : "Invalid bridge message";
	return { ok: false, error: { code: "invalid_message", message } };
}

function tokenHash(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return "Invalid JSON bridge frame";
}
