import { isRecord, validateMrtrForm } from "./form-schema.ts";
import { McpMrtrError } from "./errors.ts";

const own = (value: object, key: string) => Object.hasOwn(value, key);
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

type Input = {
	method: "elicitation/create";
	params: { mode?: "form" | "url"; message: string; requestedSchema?: unknown };
};
export function parseInputs(result: Record<string, unknown>): Map<string, Input> | undefined {
	if (!own(result, "requestState") && !own(result, "inputRequests")) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	if (own(result, "requestState") && typeof result.requestState !== "string")
		throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	if (
		byteSize(result) > 512 * 1024 ||
		(typeof result.requestState === "string" && Buffer.byteLength(result.requestState) > 64 * 1024)
	)
		throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
	if (!own(result, "inputRequests")) return undefined;
	if (!isRecord(result.inputRequests)) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	const entries = Object.entries(result.inputRequests);
	if (entries.length > 32) throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
	// Scan the complete batch before collecting anything, including unsupported capability requests.
	for (const [, input] of entries)
		if (isRecord(input) && ["roots/list", "sampling/createMessage"].includes(String(input.method)))
			throw new McpMrtrError("MCP_MRTR_UNSUPPORTED_INPUT");
	const inputs = new Map<string, Input>();
	const checkStrings = (value: unknown): void => {
		if (typeof value === "string" && Buffer.byteLength(value) > 16 * 1024)
			throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
		if (Array.isArray(value)) for (const entry of value) checkStrings(entry);
		else if (isRecord(value))
			for (const [key, entry] of Object.entries(value)) {
				checkStrings(key);
				checkStrings(entry);
			}
	};
	for (const [key, input] of entries) {
		checkStrings(key);
		if (
			!isRecord(input) ||
			input.method !== "elicitation/create" ||
			!isRecord(input.params) ||
			typeof input.params.message !== "string"
		)
			throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
		const params = input.params;
		checkStrings(params);
		if (params.mode === "url") {
			if (typeof params.url !== "string" || typeof params.elicitationId !== "string")
				throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
			throw new McpMrtrError("MCP_MRTR_UNSUPPORTED_INPUT");
		} else {
			if (params.mode !== undefined && params.mode !== "form") throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
			if (
				isRecord(params.requestedSchema) &&
				isRecord(params.requestedSchema.properties) &&
				Object.keys(params.requestedSchema.properties).length > 64
			)
				throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
			if (!validateMrtrForm(params.requestedSchema)) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
		}
		inputs.set(key, input as unknown as Input);
	}
	return inputs;
}
