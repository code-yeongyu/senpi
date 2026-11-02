import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";
import { getToolArgumentValidator, type ToolArgumentValidationError } from "./tool-argument-validator.ts";
import { coercePrimitiveByType } from "./tool-argument-coercion.ts";
export { registerToolArgumentValidator } from "./tool-argument-validator.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
	const?: unknown;
	enum?: unknown[];
	default?: unknown;
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}

	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index++) {
				const itemSchema = schema.items[index];
				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) normalizeOptionalNulls(item, schema.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !schema.properties) return;

	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;
		if (
			object[key] === null &&
			!required.has(key) &&
			typeof (propertySchema as { $ref?: unknown }).$ref !== "string" &&
			getSubSchemaValidator(propertySchema)?.Check(null) === false
		) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], propertySchema);
		}
	}
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: ToolArgumentValidationError): string {
	if (error.keyword === "required") {
		const requiredProperty = error.params.requiredProperties?.[0] ?? error.params.missingProperty;
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

interface DiscriminatedBranch {
	readonly schema: JsonSchemaObject;
	readonly values: readonly unknown[];
	readonly optional: boolean;
	readonly defaultValue: unknown;
}

interface DiscriminatedUnion {
	readonly property: string;
	readonly branches: readonly DiscriminatedBranch[];
	readonly defaultValue: unknown;
}

function constValues(schema: JsonSchemaObject | undefined): unknown[] | undefined {
	if (!schema) return undefined;
	if ("const" in schema) return [schema.const];
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return [...schema.enum];
	const members = schema.anyOf ?? schema.oneOf;
	if (!Array.isArray(members) || members.length === 0) return undefined;
	const values: unknown[] = [];
	for (const member of members) {
		const memberValues = constValues(member);
		if (!memberValues) return undefined;
		values.push(...memberValues);
	}
	return values;
}

function discriminatedBranches(members: JsonSchemaObject[], property: string): DiscriminatedBranch[] | undefined {
	const seen = new Set<unknown>();
	const branches: DiscriminatedBranch[] = [];
	for (const member of members) {
		const propertySchema = member.properties?.[property];
		const values = constValues(propertySchema);
		if (!values || values.some((value) => seen.has(value))) return undefined;
		for (const value of values) seen.add(value);
		branches.push({
			schema: member,
			values,
			optional: !(member.required ?? []).includes(property),
			defaultValue: propertySchema?.default,
		});
	}
	return branches;
}

/** An anyOf/oneOf of object branches that every carry a const-valued property with disjoint values. */
function findDiscriminatedUnion(schema: JsonSchemaObject): DiscriminatedUnion | undefined {
	const members = schema.anyOf ?? schema.oneOf;
	if (!Array.isArray(members) || members.length < 2) return undefined;
	const [first] = members;
	if (!first?.properties || !members.every((member) => member.properties !== undefined)) return undefined;
	for (const property of Object.keys(first.properties)) {
		const branches = discriminatedBranches(members, property);
		if (!branches) continue;
		const defaultValue =
			schema.properties?.[property]?.default ??
			branches.map((branch) => branch.defaultValue).find((value) => value !== undefined);
		return { property, branches, defaultValue };
	}
	return undefined;
}

function selectBranch(
	union: DiscriminatedUnion,
	value: unknown,
): { branch: DiscriminatedBranch; value: unknown; defaulted: boolean } | "unknown" | undefined {
	if (value !== undefined) {
		const branch = union.branches.find((candidate) => candidate.values.includes(value));
		return branch ? { branch, value, defaulted: false } : "unknown";
	}
	if (union.defaultValue !== undefined) {
		const branch = union.branches.find((candidate) => candidate.values.includes(union.defaultValue));
		if (branch) return { branch, value: union.defaultValue, defaulted: true };
	}
	const optional = union.branches.filter((candidate) => candidate.optional);
	const [only] = optional;
	if (optional.length === 1 && only && only.values.length === 1) {
		return { branch: only, value: only.values[0], defaulted: true };
	}
	return undefined;
}

/**
 * For a discriminated union, report only the branch the arguments address, as one line, so the caller
 * sees which field to fix instead of every branch's mismatch. Undefined means use the full error list.
 */
function formatDiscriminatedUnionError(
	schema: JsonSchemaObject,
	validator: ReturnType<typeof Compile>,
	args: unknown,
): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const union = findDiscriminatedUnion(schema);
	if (!union) return undefined;
	const received = (args as Record<string, unknown>)[union.property];
	const selected = selectBranch(union, received);
	if (selected === undefined) return undefined;
	if (selected === "unknown") {
		const allowed = union.branches.flatMap((branch) => branch.values).map((value) => JSON.stringify(value));
		return `  - ${union.property}: must be one of ${allowed.join(", ")} (received ${JSON.stringify(received)})`;
	}
	const branchValidator = getSubSchemaValidator(selected.branch.schema);
	if (!branchValidator) return undefined;
	const rootErrors = validator
		.Errors(args)
		.filter((error) => error.keyword !== "anyOf" && error.keyword !== "oneOf")
		.filter((error) => !/^#\/(?:anyOf|oneOf)(?:\/|$)/.test(error.schemaPath));
	const messages = [...rootErrors, ...branchValidator.Errors(args)].map(
		(error) => `${formatValidationPath(error)}: ${error.message}`,
	);
	const unique = [...new Set(messages)];
	if (unique.length === 0) return undefined;
	const label = `for ${union.property} ${JSON.stringify(selected.value)}${selected.defaulted ? ` (default when ${union.property} is omitted)` : ""}`;
	return `  - ${label}: ${unique.join("; ")}`;
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = structuredClone(toolCall.arguments);
	const protocolValidator = getToolArgumentValidator(tool.parameters);
	if (protocolValidator !== undefined) {
		if (!protocolValidator(args)) {
			const errors =
				protocolValidator.errors
					?.map(
						(error) => `  - ${formatValidationPath(error)}: ${error.message ?? error.keyword} (${error.keyword})`,
					)
					.join("\n") || "Unknown validation error";
			throw new Error(`Validation failed for tool "${toolCall.name}":\n${errors}`);
		}
		return args;
	}
	normalizeOptionalNulls(args, tool.parameters as JsonSchemaObject);
	Value.Convert(tool.parameters, args);

	const validator = getValidator(tool.parameters);
	if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
		if (coerced !== args) {
			if (typeof args === "object" && args !== null && typeof coerced === "object" && coerced !== null) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else {
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}

	if (validator.Check(args)) {
		return args;
	}

	const errors =
		formatDiscriminatedUnionError(tool.parameters as JsonSchemaObject, validator, args) ??
		(validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") ||
			"Unknown validation error");

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
