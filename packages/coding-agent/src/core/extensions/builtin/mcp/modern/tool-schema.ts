import { Ajv, type ValidateFunction } from "ajv";
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
const draft2020 = "https://json-schema.org/draft/2020-12/schema";
const draft07 = "http://json-schema.org/draft-07/schema";
const ajvOptions = {
	strict: false,
	validateFormats: false,
	allErrors: false,
	inlineRefs: false,
	addUsedSchema: false,
} as const;
// Reuse each dialect's meta-schema checker without adding tool schemas to its $id namespace.
const metaSchemaChecker = new Map<typeof Ajv | typeof Ajv2020, Ajv | Ajv2020>();

/** No coercion/default insertion/removal, no network resolver, no shared $id namespace. */
export function compileModernSchema(schema: McpJsonSchema): ValidateFunction {
	checkBounds(schema);
	const key = JSON.stringify(schema);
	const cached = validators.get(key);
	if (cached !== undefined) return cached;
	const declaredDialect = typeof schema === "boolean" ? undefined : schema.$schema;
	const usesDraft07 = declaredDialect === draft07 || declaredDialect === `${draft07}#`;
	if (
		!usesDraft07 &&
		declaredDialect !== undefined &&
		declaredDialect !== draft2020 &&
		declaredDialect !== `${draft2020}#`
	) {
		throw new McpToolSchemaError(
			"MCP_SCHEMA_UNSUPPORTED_DIALECT",
			"Modern MCP supports JSON Schema 2020-12 and draft-07.",
		);
	}
	try {
		if (typeof schema !== "boolean" && schema.$async !== undefined)
			throw new McpToolSchemaError("MCP_SCHEMA_INVALID", "Async schemas are unsupported.");
		const Validator = usesDraft07 ? Ajv : Ajv2020;
		// Draft-07 ignores validation keywords beside $ref. Ajv warns when using this compatibility option.
		const options = usesDraft07 ? { ...ajvOptions, ignoreKeywordsWithRef: true, logger: false as const } : ajvOptions;
		let checker = metaSchemaChecker.get(Validator);
		if (checker === undefined) {
			checker = new Validator(options);
			metaSchemaChecker.set(Validator, checker);
		}
		if (checker.validateSchema(schema) !== true) {
			throw new McpToolSchemaError("MCP_SCHEMA_INVALID", "Invalid MCP schema or unresolved schema reference.");
		}
		const validationSchema = usesDraft07 && typeof schema !== "boolean" ? prepareDraft07Refs(schema) : schema;
		// Draft-07 root self-references need this registration. The compiler is per schema, so IDs stay isolated.
		const validate = new Validator({ ...options, addUsedSchema: usesDraft07, validateSchema: false }).compile(
			validationSchema,
		);
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

// Ajv handles $id, type, and nullable before applying ignoreKeywordsWithRef.
// Ignore those siblings on reference objects without changing the raw schema or literal values.
function prepareDraft07Refs(schema: object): Record<string, unknown> {
	const visit = (value: unknown) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
		return prepareDraft07Refs(value);
	};
	const result: Record<string, unknown> = { ...schema };
	if (typeof result.$ref === "string") {
		delete result.$id;
		delete result.type;
		delete result.nullable;
	}
	for (const key of [
		"additionalItems",
		"additionalProperties",
		"contains",
		"propertyNames",
		"not",
		"if",
		"then",
		"else",
	]) {
		if (Object.hasOwn(result, key)) result[key] = visit(result[key]);
	}
	for (const key of ["items", "allOf", "anyOf", "oneOf"]) {
		const value = result[key];
		if (Array.isArray(value)) result[key] = value.map(visit);
		else if (Object.hasOwn(result, key)) result[key] = visit(value);
	}
	for (const key of ["definitions", "$defs", "properties", "patternProperties", "dependencies"]) {
		const value = result[key];
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]));
	}
	return result;
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
