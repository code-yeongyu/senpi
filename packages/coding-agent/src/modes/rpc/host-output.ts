import { MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import type { RpcResponse } from "./rpc-types.ts";

export function parseError(error: string): RpcResponse {
	return { type: "response", command: "parse", success: false, error };
}

export function oversizedLineError(): string {
	return `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`;
}

export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function hostLog(message: string): void {
	process.stderr.write(`senpi rpc host: ${message}\n`);
}
