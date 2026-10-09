import { kernelToolError } from "./kernel-tools-errors.js";

export function defaultInputSchema(params) {
	return {
		type: "object",
		properties: Object.fromEntries(params.map((name) => [name, {}])),
		required: [...params],
		additionalProperties: false,
	};
}

export function resolveToolMetadata(metadata, params) {
	if (metadata === undefined) return { description: "", input_schema: defaultInputSchema(params) };
	if (!isPlainJsonObject(metadata)) {
		throw kernelToolError("invalid_tool_definition", "tool() metadata must be plain JSON");
	}
	const description = metadata.description === undefined ? "" : metadata.description;
	if (typeof description !== "string") {
		throw kernelToolError("invalid_tool_definition", "tool() description must be a string");
	}
	if (metadata.name !== undefined && typeof metadata.name !== "string") {
		throw kernelToolError("invalid_tool_definition", "tool() name must be a string");
	}
	const named = metadata.name === undefined ? {} : { name: metadata.name };
	if (metadata.schema === undefined) return { ...named, description, input_schema: defaultInputSchema(params) };
	const schema = metadata.schema;
	if (!isPlainJsonObject(schema) || schema.type !== "object" || !isPlainJsonObject(schema.properties)) {
		throw kernelToolError("invalid_tool_definition", "tool() metadata schema must be a JSON object schema");
	}
	const propertyKeys = Object.keys(schema.properties);
	if (propertyKeys.length !== params.length || params.some((name) => !Object.hasOwn(schema.properties, name))) {
		throw kernelToolError("invalid_tool_definition", "tool() metadata schema properties must match parameters");
	}
	return { ...named, description, input_schema: schema };
}

export function validateInvokeArgs(schema, args) {
	if (!isPlainJsonObject(args)) throw kernelToolError("invalid_tool_definition", "kernel tool args must be a JSON object");
	const required = Array.isArray(schema.required) ? schema.required : [];
	for (const key of required) {
		if (!Object.hasOwn(args, key)) {
			throw kernelToolError("invalid_tool_definition", `missing kernel tool argument: ${key}`);
		}
	}
	if (schema.additionalProperties === false) {
		const allowed = new Set(Object.keys(schema.properties ?? {}));
		for (const key of Object.keys(args)) {
			if (!allowed.has(key)) {
				throw kernelToolError("invalid_tool_definition", `unexpected kernel tool argument: ${key}`);
			}
		}
	}
}

export function isPlainJsonObject(value) {
	return isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonValue(value) {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (type !== "object") return false;
	if (Array.isArray(value)) return value.every(isJsonValue);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.values(value).every(isJsonValue);
}

export function orderedArgs(params, args) {
	return params.map((name) => args[name]);
}
