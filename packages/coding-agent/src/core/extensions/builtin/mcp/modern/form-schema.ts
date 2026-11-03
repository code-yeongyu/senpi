export type Value = string | number | boolean | string[];
export type Property = Record<string, unknown>;
export type ValidatedMcpFormSchema = Form;
type Form = { type: "object"; properties: Record<string, Property>; required?: string[] };
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);

export function enums(property: Property): Array<{ value: string; label: string }> | undefined {
	if (
		Array.isArray(property.enum) &&
		property.enum.length > 0 &&
		property.enum.every((entry) => typeof entry === "string")
	) {
		return property.enum.map((value) => ({ value, label: value }));
	}
	const choices = property.oneOf ?? property.anyOf;
	if (
		Array.isArray(choices) &&
		choices.length > 0 &&
		choices.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.const === "string" &&
				typeof entry.title === "string" &&
				Object.keys(entry).every((key) => key === "const" || key === "title"),
		)
	) {
		return choices.map((entry) => ({ value: entry.const as string, label: entry.title as string }));
	}
	return undefined;
}

export function validValue(property: Property, value: unknown): value is Value {
	if (property.type === "boolean") return typeof value === "boolean";
	if (property.type === "integer" || property.type === "number") {
		return (
			typeof value === "number" &&
			Number.isFinite(value) &&
			(property.type !== "integer" || Number.isInteger(value)) &&
			(typeof property.minimum !== "number" || value >= property.minimum) &&
			(typeof property.maximum !== "number" || value <= property.maximum)
		);
	}
	if (property.type === "array") {
		const choices = isRecord(property.items) ? enums(property.items) : undefined;
		return (
			Array.isArray(value) &&
			value.every((entry) => typeof entry === "string" && choices?.some((choice) => choice.value === entry)) &&
			new Set(value).size === value.length &&
			(typeof property.minItems !== "number" || value.length >= property.minItems) &&
			(typeof property.maxItems !== "number" || value.length <= property.maxItems)
		);
	}
	if (typeof value !== "string") return false;
	const choices = enums(property);
	if (choices && !choices.some((choice) => choice.value === value)) return false;
	if (typeof property.minLength === "number" && [...value].length < property.minLength) return false;
	if (typeof property.maxLength === "number" && [...value].length > property.maxLength) return false;
	switch (property.format) {
		case "email":
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
		case "uri": {
			try {
				return new URL(value).protocol.length > 1;
			} catch {
				return false;
			}
		}
		case "date":
			return (
				/^\d{4}-\d{2}-\d{2}$/.test(value) &&
				Number.isFinite(Date.parse(value)) &&
				new Date(value).toISOString().slice(0, 10) === value
			);
		case "date-time": {
			const date = value.slice(0, 10);
			return (
				/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
					value,
				) &&
				Number.isFinite(Date.parse(value)) &&
				new Date(date).toISOString().slice(0, 10) === date
			);
		}
		default:
			return true;
	}
}

/** Validate a complete submitted form, including unknown keys and omitted required fields. */
export function validMcpFormContent(schema: Form, content: unknown): content is Record<string, Value> {
	return (
		isRecord(content) &&
		(schema.required ?? []).every((key) => own(content, key)) &&
		Object.entries(content).every(
			([key, value]) => own(schema.properties, key) && validValue(schema.properties[key], value),
		)
	);
}

/** Reject unsupported constraints rather than presenting a weaker schema. */
export function validateMrtrForm(schema: unknown): schema is Form {
	if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return false;
	for (const key of ["title", "description"]) if (own(schema, key) && typeof schema[key] !== "string") return false;
	if (
		Object.keys(schema).some(
			(key) => !["type", "properties", "required", "title", "description", "$schema"].includes(key),
		)
	)
		return false;
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) ||
			!schema.required.every((key) => typeof key === "string" && own(schema.properties as object, key)))
	)
		return false;
	for (const property of Object.values(schema.properties)) {
		if (!isRecord(property)) return false;
		const allowed = ["type", "title", "description", "default"];
		switch (property.type) {
			case "string":
				allowed.push("minLength", "maxLength", "format", "enum", "oneOf");
				if (
					property.format !== undefined &&
					!["email", "uri", "date", "date-time"].includes(String(property.format))
				)
					return false;
				if ((own(property, "enum") || own(property, "oneOf")) && !enums(property)) return false;
				if (own(property, "enum") && own(property, "oneOf")) return false;
				break;
			case "number":
			case "integer":
				allowed.push("minimum", "maximum");
				break;
			case "boolean":
				break;
			case "array":
				allowed.push("items", "minItems", "maxItems");
				if (
					!isRecord(property.items) ||
					!enums(property.items) ||
					Object.keys(property.items).some((key) => !["type", "enum", "anyOf"].includes(key)) ||
					(property.items.type !== undefined && property.items.type !== "string")
				)
					return false;
				break;
			default:
				return false;
		}
		if (Object.keys(property).some((key) => !allowed.includes(key))) return false;
		for (const key of ["title", "description"])
			if (own(property, key) && typeof property[key] !== "string") return false;
		for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
			const value = property[key];
			if (
				value !== undefined &&
				(typeof value !== "number" ||
					!Number.isFinite(value) ||
					(!["minimum", "maximum"].includes(key) && (!Number.isInteger(value) || value < 0)))
			)
				return false;
		}
		for (const [min, max] of [
			["minimum", "maximum"],
			["minLength", "maxLength"],
			["minItems", "maxItems"],
		]) {
			if (
				min &&
				max &&
				typeof property[min] === "number" &&
				typeof property[max] === "number" &&
				property[min] > property[max]
			)
				return false;
		}
		if (own(property, "default") && !validValue(property, property.default)) return false;
	}
	return true;
}
