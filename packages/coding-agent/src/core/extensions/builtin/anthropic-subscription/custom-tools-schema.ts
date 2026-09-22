import { type ZodRawShape, type ZodTypeAny, z } from "zod";

type JsonSchema = {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: Array<string | number | boolean>;
	const?: string | number | boolean | null;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	description?: string;
};

function schemaToZod(schema: JsonSchema): ZodTypeAny {
	if (schema.const !== undefined) {
		return schema.const === null ? z.null() : z.literal(schema.const);
	}
	if (schema.enum && schema.enum.length > 0) {
		const values = schema.enum.filter((value): value is string | number | boolean =>
			["string", "number", "boolean"].includes(typeof value),
		);
		if (values.length === 1) {
			return z.literal(values[0]!);
		}
		if (values.length > 1) {
			const [first, second, ...rest] = values.map((value) => z.literal(value));
			return z.union([first!, second!, ...rest]);
		}
	}
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants && variants.length > 0) {
		const converted = variants.map((variant) => schemaToZod(variant));
		if (converted.length === 1) return converted[0]!;
		const [first, second, ...rest] = converted;
		return z.union([first!, second!, ...rest]);
	}
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	switch (type) {
		case "string":
			return z.string();
		case "number":
			return z.number();
		case "integer":
			return z.number().int();
		case "boolean":
			return z.boolean();
		case "null":
			return z.null();
		case "array":
			return z.array(schema.items ? schemaToZod(schema.items) : z.unknown());
		case "object":
			return objectToShape(schema);
		default:
			return z.unknown();
	}
}

export function objectToShape(schema: JsonSchema): ZodTypeAny {
	return z.object(jsonSchemaToZodShape(schema));
}

export function jsonSchemaToZodShape(schema: unknown): ZodRawShape {
	const object = (schema ?? {}) as JsonSchema;
	const properties = object.properties ?? {};
	const required = new Set(object.required ?? []);
	const shape: Record<string, ZodTypeAny> = {};
	for (const [key, value] of Object.entries(properties)) {
		const converted = schemaToZod(value);
		shape[key] = required.has(key) ? converted : converted.optional();
	}
	return shape;
}
