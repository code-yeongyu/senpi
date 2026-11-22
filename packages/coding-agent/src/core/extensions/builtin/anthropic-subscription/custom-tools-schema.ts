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
	let converted: ZodTypeAny | undefined;
	if (schema.const !== undefined) {
		converted = schema.const === null ? z.null() : z.literal(schema.const);
	} else if (schema.enum && schema.enum.length > 0) {
		const values = schema.enum.filter((value): value is string | number | boolean =>
			["string", "number", "boolean"].includes(typeof value),
		);
		if (values.length === 1) {
			converted = z.literal(values[0]!);
		} else if (values.length > 1) {
			const [first, second, ...rest] = values.map((value) => z.literal(value));
			converted = z.union([first!, second!, ...rest]);
		}
	}
	if (converted === undefined) {
		const variants = schema.anyOf ?? schema.oneOf;
		if (variants && variants.length > 0) {
			const variantsConverted = variants.map((variant) => schemaToZod(variant));
			if (variantsConverted.length === 1) {
				converted = variantsConverted[0]!;
			} else {
				const [first, second, ...rest] = variantsConverted;
				converted = z.union([first!, second!, ...rest]);
			}
		} else {
			const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
			switch (type) {
				case "string":
					converted = z.string();
					break;
				case "number":
					converted = z.number();
					break;
				case "integer":
					converted = z.number().int();
					break;
				case "boolean":
					converted = z.boolean();
					break;
				case "null":
					converted = z.null();
					break;
				case "array":
					converted = z.array(schema.items ? schemaToZod(schema.items) : z.unknown());
					break;
				case "object":
					converted = objectToShape(schema);
					break;
				default:
					converted = z.unknown();
					break;
			}
		}
	}
	if (converted === undefined) throw new Error("schema conversion did not produce a Zod type");
	return typeof schema.description === "string" ? converted.describe(schema.description) : converted;
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
