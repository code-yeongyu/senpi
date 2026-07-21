import type { Readable } from "node:stream";
import { attachJsonlLineReader } from "../../rpc/jsonl.ts";
import type {
	ClassifiedIncoming,
	RpcEnvelope,
	RpcErrorResponse,
	RpcNotification,
	RpcRequest,
	RpcResponse,
} from "./envelope.ts";
import { classifyIncoming } from "./envelope.ts";

export type NdjsonRpcEmission =
	| ClassifiedIncoming
	| { readonly kind: "parse-error"; readonly message: RpcErrorResponse };

function messageWithoutJsonrpc(message: RpcEnvelope): RpcEnvelope {
	if ("method" in message) {
		if ("id" in message) {
			return "params" in message
				? { id: message.id, method: message.method, params: message.params }
				: { id: message.id, method: message.method };
		}
		return {
			method: message.method,
			...("params" in message ? { params: message.params } : {}),
			...("emittedAtMs" in message ? { emittedAtMs: message.emittedAtMs } : {}),
		};
	}

	if ("result" in message) {
		return { id: message.id, result: message.result };
	}

	return {
		id: message.id,
		error:
			"data" in message.error
				? { code: message.error.code, message: message.error.message, data: message.error.data }
				: { code: message.error.code, message: message.error.message },
	};
}

export function serializeNdjsonMessage(message: RpcRequest | RpcResponse | RpcNotification): string {
	const serialized = JSON.stringify(messageWithoutJsonrpc(message));
	if (serialized === undefined) {
		throw new Error("JSON-RPC message did not serialize to an object");
	}
	if (serialized.includes("\n")) {
		throw new Error("JSON-RPC NDJSON payload must not contain a raw newline");
	}
	return `${serialized}\n`;
}

export function parseNdjsonLine(line: string): NdjsonRpcEmission {
	try {
		return classifyIncoming(JSON.parse(line));
	} catch (error) {
		if (error instanceof SyntaxError) {
			return { kind: "parse-error", message: { id: null, error: { code: -32700, message: "Parse error" } } };
		}
		throw error;
	}
}

export function attachNdjsonRpcReader(stream: Readable, onMessage: (message: NdjsonRpcEmission) => void): () => void {
	return attachJsonlLineReader(stream, (line) => {
		onMessage(parseNdjsonLine(line));
	});
}
