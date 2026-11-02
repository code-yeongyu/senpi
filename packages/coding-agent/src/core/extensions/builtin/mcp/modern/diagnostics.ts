import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpMrtrError } from "./errors.ts";

/** Control/diagnostic payloads are private from admission, not merely after consent starts. */
export function sanitizeModernMessage(message: JSONRPCMessage): JSONRPCMessage | undefined {
	if ("error" in message)
		return {
			jsonrpc: "2.0",
			id: message.id,
			error: { code: message.error.code, message: "MCP server request failed." },
		};
	if (!("method" in message)) return message;
	if ("id" in message) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
	if (message.method === "notifications/progress") {
		const params = message.params;
		if (
			!params ||
			typeof params.progress !== "number" ||
			!Number.isFinite(params.progress) ||
			(params.total !== undefined && (typeof params.total !== "number" || !Number.isFinite(params.total)))
		)
			return undefined;
		return {
			jsonrpc: "2.0",
			method: message.method,
			params: {
				progressToken: params.progressToken,
				progress: params.progress,
				...(params.total === undefined ? {} : { total: params.total }),
			},
		};
	}
	if (message.method === "notifications/message")
		return {
			jsonrpc: "2.0",
			method: message.method,
			params: { level: "info", data: "MCP server diagnostic suppressed." },
		};
	return message;
}
