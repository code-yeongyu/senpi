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
const validators = new Map<string, ValidateFunction>();
const MAX_CACHED_VALIDATORS = 1024;
const dialect = "https://json-schema.org/draft/2020-12/schema";
const ajvOptions = {
	strict: false,
	validateFormats: false,
	allErrors: false,
	inlineRefs: false,
	addUsedSchema: false,
} as const;
// Checks schemas against the 2020-12 meta-schema without adding them, so it keeps no $id namespace and compiles
// the meta-schema once instead of once per tool schema.
let metaSchemaChecker: Ajv2020 | undefined;

/** No coercion/default insertion/removal, no network resolver, no shared $id namespace. */
export function compileModernSchema(schema: McpJsonSchema): ValidateFunction {
	checkBounds(schema);
	const key = JSON.stringify(schema);
	const cached = validators.get(key);
	if (cached !== undefined) return cached;
	if (
		typeof schema !== "boolean" &&
		schema.$schema !== undefined &&
		schema.$schema !== dialect &&
		schema.$schema !== `${dialect}#`
	) {
		throw new McpToolSchemaError("MCP_SCHEMA_UNSUPPORTED_DIALECT", "Modern MCP supports JSON Schema 2020-12.");
	}
	try {
		if (typeof schema !== "boolean" && schema.$async !== undefined)
			throw new McpToolSchemaError("MCP_SCHEMA_INVALID", "Async schemas are unsupported.");
		metaSchemaChecker ??= new Ajv2020(ajvOptions);
		if (metaSchemaChecker.validateSchema(schema) !== true) {
			throw new McpToolSchemaError("MCP_SCHEMA_INVALID", "Invalid MCP schema or unresolved schema reference.");
		}
		const validate = new Ajv2020({ ...ajvOptions, validateSchema: false }).compile(schema);
		if (validators.size >= MAX_CACHED_VALIDATORS) {
			const oldest = validators.keys().next().value;
			if (oldest !== undefined) validators.delete(oldest);
		}
		validators.set(key, validate);
		return validate;
	} catch (error) {
		if (error instanceof McpToolSchemaError) throw error;
		throw new McpToolSchemaError("MCP_SCHEMA_INVALID", "Invalid MCP schema or unresolved schema reference.");
	}
}

/** Reject one unusable definition, never its valid siblings; diagnostics contain no schema or arguments. */
export function hasSupportedModernToolSchemas(
	tool: Pick<McpListedTool, "name" | "inputSchema" | "outputSchema">,
): boolean {
	try {
		compileModernSchema(tool.inputSchema);
		if (tool.outputSchema !== undefined) compileModernSchema(tool.outputSchema);
		return true;
	} catch (error) {
		if (!(error instanceof McpToolSchemaError)) throw error;
		console.warn(`MCP tool ${JSON.stringify(tool.name)} skipped: ${error.code}: ${error.message}`);
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
