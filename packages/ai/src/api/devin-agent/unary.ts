/**
 * Unary Cascade RPCs (`GetUserJwt`, `AssignModel`, `GetCliModelConfigs`).
 *
 * Unlike the streaming chat call these carry a bare protobuf body both ways.
 * Edges variously answer with plain or gzipped protobuf, so decoding tries the
 * bytes as-is before falling back to gunzip. Discovery reaches this module from
 * the provider factory, which is root-reachable, so the gunzip path uses the
 * web `DecompressionStream` rather than `node:zlib`.
 */

import {
	create,
	type DescMessage,
	fromBinary,
	type MessageInitShape,
	type MessageShape,
	toBinary,
} from "@bufbuild/protobuf";
import { DEVIN_UNARY_HEADERS } from "./paths.ts";

export class DevinUnaryError extends Error {
	readonly rpc: string;
	readonly status: number;

	constructor(rpc: string, status: number, detail: string) {
		super(`Devin ${rpc} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
		this.name = "DevinUnaryError";
		this.rpc = rpc;
		this.status = status;
	}
}

export interface DevinUnaryInput<TRequest extends DescMessage, TResponse extends DescMessage> {
	baseUrl: string;
	path: string;
	requestSchema: TRequest;
	request: MessageInitShape<TRequest>;
	responseSchema: TResponse;
	signal?: AbortSignal;
}

export async function postDevinUnary<TRequest extends DescMessage, TResponse extends DescMessage>(
	input: DevinUnaryInput<TRequest, TResponse>,
): Promise<MessageShape<TResponse>> {
	const response = await fetch(input.baseUrl + input.path, {
		method: "POST",
		headers: DEVIN_UNARY_HEADERS,
		body: copyOf(toBinary(input.requestSchema, create(input.requestSchema, input.request))),
		signal: input.signal,
	});
	const payload = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		throw new DevinUnaryError(rpcName(input.path), response.status, new TextDecoder().decode(payload).slice(0, 500));
	}
	const decoded = await decodeDevinUnary(input.responseSchema, payload);
	if (!decoded) throw new DevinUnaryError(rpcName(input.path), response.status, "response is not a protobuf message");
	return decoded;
}

export async function decodeDevinUnary<TSchema extends DescMessage>(
	schema: TSchema,
	payload: Uint8Array,
): Promise<MessageShape<TSchema> | undefined> {
	try {
		return fromBinary(schema, payload);
	} catch {
		try {
			return fromBinary(schema, await gunzip(payload));
		} catch {
			return undefined;
		}
	}
}

async function gunzip(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const inflated = new Blob([copyOf(payload)]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(inflated).arrayBuffer());
}

function rpcName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function copyOf(source: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(source.byteLength);
	out.set(source);
	return out;
}
