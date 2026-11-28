import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { McpJsonSchema, McpListedTool } from "../tool-contracts.ts";

type SchemaErrorCode =
	| "MCP_SCHEMA_UNSUPPORTED_DIALECT"
	| "MCP_SCHEMA_INVALID"
	| "MCP_SCHEMA_LIMIT"
	| "MCP_OUTPUT_SCHEMA_MISMATCH";
export class McpToolSchemaError extends Error {
	readonly code: SchemaErrorCode;
	constructor(code: SchemaErrorCode, message: string) {
		super(message);
		this.name = "McpToolSchemaError";
		this.code = code;
	}
}

// Keyed by content, not identity: every catalog cache read parses fresh schema objects, and recompiling a
// large catalog on each read blocked startup for seconds.
// Keep failures too: an invalid tool must not retry compilation on every invocation.
const validators = new Map<string, ValidateFunction | McpToolSchemaError>();
const dialect = "https://json-schema.org/draft/2020-12/schema";
const ajvOptions = {
	strict: false,
	validateFormats: false,
	allErrors: false,
	inlineRefs: false,
	addUsedSchema: false,
} as const;
let compiler: Ajv2020 | undefined;

/** No coercion/default insertion/removal, no network resolver, no shared $id namespace. */
export function compileModernSchema(schema: McpJsonSchema, toolName?: string): ValidateFunction {
	try {
		checkBounds(schema);
		const key = JSON.stringify(schema);
		let cached = validators.get(key);
		if (cached === undefined) {
			try {
				if (
					typeof schema !== "boolean" &&
					schema.$schema !== undefined &&
					schema.$schema !== dialect &&
					schema.$schema !== `${dialect}#`
				) {
					throw new McpToolSchemaError(
						"MCP_SCHEMA_UNSUPPORTED_DIALECT",
						"Modern MCP supports JSON Schema 2020-12.",
					);
				}
				if (typeof schema !== "boolean" && schema.$async !== undefined)
					throw new McpToolSchemaError("MCP_SCHEMA_INVALID", "Async schemas are unsupported.");
				compiler ??= new Ajv2020(ajvOptions);
				cached = compiler.compile(schema);
			} catch (error) {
				cached =
					error instanceof McpToolSchemaError
						? error
						: new McpToolSchemaError("MCP_SCHEMA_INVALID", "Invalid MCP schema or unresolved schema reference.");
			} finally {
				// addUsedSchema:false alone leaves nested $id/$anchor aliases behind.
				// Compiled functions retain their local refs; only the shared compiler is cleared.
				compiler?.removeSchema();
			}
			validators.set(key, cached);
		}
		if (cached instanceof McpToolSchemaError) throw cached;
		return cached;
	} catch (error) {
		if (error instanceof McpToolSchemaError && toolName !== undefined) {
			console.warn(`MCP tool ${JSON.stringify(toolName)} skipped: ${error.code}: ${error.message}`);
		}
		throw error;
	}
}

/** Reject one unusable definition, never its valid siblings; diagnostics contain no schema or arguments. */
export function hasSupportedModernToolSchemas(
	tool: Pick<McpListedTool, "name" | "inputSchema" | "outputSchema">,
): boolean {
	try {
		compileModernSchema(tool.inputSchema, tool.name);
		if (tool.outputSchema !== undefined) compileModernSchema(tool.outputSchema, tool.name);
		return true;
	} catch (error) {
		if (!(error instanceof McpToolSchemaError)) throw error;
		return false;
	}
}

function checkBounds(schema: McpJsonSchema): void {
	const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
	let nodes = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		if (++nodes > 16_384 || current.depth > 64) {
			throw new McpToolSchemaError("MCP_SCHEMA_LIMIT", "MCP schema exceeds the depth or node limit.");
		}
		if (current.value !== null && typeof current.value === "object") {
			for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
		}
	}
}
