const SCHEMA_HINT_MAX_CHARS = 1_200;
const SCHEMA_HINT_MAX_PROPERTIES = 30;
const DESCRIPTION_MAX_CHARS = 80;
const ENUM_MAX_VALUES = 8;
const NESTED_MAX_DEPTH = 2;
const HINT_HEADER = "Expected parameters:";

interface SchemaLike {
	readonly type?: unknown;
	readonly properties?: unknown;
	readonly required?: unknown;
	readonly items?: unknown;
	readonly description?: unknown;
	readonly enum?: unknown;
	readonly const?: unknown;
	readonly oneOf?: unknown;
	readonly anyOf?: unknown;
	readonly allOf?: unknown;
}

export function appendSchemaHint(message: string, toolName: string, schema: unknown): string {
	const rendered = renderSchemaHint(toolName, schema);
	if (rendered === undefined) return message;
	return `${message}\n\n${HINT_HEADER}\n${rendered}`;
}

export function renderSchemaHint(toolName: string, schema: unknown): string | undefined {
	if (!isSchemaLike(schema)) return undefined;
	const lines = renderObjectLines(schema, 0, 1);
	if (lines.length === 0) return undefined;
	return fitLines(lines, `[truncated; call tool_schema(${JSON.stringify(toolName)}) for the full schema]`);
}

function renderObjectLines(schema: SchemaLike, indent: number, depth: number): readonly string[] {
	const required = stringArray(schema.required);
	const entries = propertyEntries(schema.properties);
	if (entries.length === 0 && required.length === 0) return [];

	const ordered = [
		...entries.filter(([name]) => required.includes(name)),
		...entries.filter(([name]) => !required.includes(name)),
	];
	const pad = "  ".repeat(indent + 1);
	const lines: string[] = [];
	if (indent === 0 && required.length > 0) lines.push(`required: ${required.join(", ")}`);

	const shown = ordered.slice(0, SCHEMA_HINT_MAX_PROPERTIES);
	for (const [name, value] of shown) {
		lines.push(`${pad}${name}${required.includes(name) ? "" : "?"}: ${describeProperty(value)}`);
		lines.push(...nestedLines(value, indent, depth));
	}
	const hidden = ordered.length - shown.length;
	if (hidden > 0) lines.push(`${pad}… ${hidden} more propert${hidden === 1 ? "y" : "ies"}`);
	return lines;
}

function nestedLines(value: unknown, indent: number, depth: number): readonly string[] {
	if (depth >= NESTED_MAX_DEPTH || !isSchemaLike(value)) return [];
	const nested = isSchemaLike(value.items) ? value.items : value;
	if (propertyEntries(nested.properties).length === 0) return [];
	return renderObjectLines(nested, indent + 1, depth + 1);
}

function describeProperty(value: unknown): string {
	if (!isSchemaLike(value)) return "unknown";
	const parts = [typeLabel(value)];
	const description = firstLine(value.description);
	if (description !== undefined) parts.push(`(${truncate(description, DESCRIPTION_MAX_CHARS)})`);
	return parts.join(" ");
}

function typeLabel(schema: SchemaLike): string {
	if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
	const enumValues = schema.enum;
	if (Array.isArray(enumValues) && enumValues.length > 0) return unionLabel(enumValues.map(literal));
	const branches = schema.oneOf ?? schema.anyOf;
	if (Array.isArray(branches) && branches.length > 0) return unionLabel(branches.map(branchLabel));
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) return branchLabel(schema.allOf[0]);

	const type = schema.type;
	const base = typeof type === "string" ? type : Array.isArray(type) ? type.filter(isString).join("|") : "unknown";
	if (base !== "array") return base;
	return isSchemaLike(schema.items) ? `array<${typeLabel(schema.items)}>` : "array";
}

function unionLabel(values: readonly string[]): string {
	const shown = values.slice(0, ENUM_MAX_VALUES).join(" | ");
	return values.length > ENUM_MAX_VALUES ? `${shown} | … (${values.length - ENUM_MAX_VALUES} more)` : shown;
}

function branchLabel(value: unknown): string {
	return isSchemaLike(value) ? typeLabel(value) : "unknown";
}

function literal(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function fitLines(lines: readonly string[], marker: string): string {
	const budget = SCHEMA_HINT_MAX_CHARS - HINT_HEADER.length - 1;
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const next = used + line.length + (kept.length === 0 ? 0 : 1);
		if (next > budget - marker.length - 1) {
			kept.push(marker);
			return kept.join("\n");
		}
		kept.push(line);
		used = next;
	}
	return kept.join("\n");
}

function propertyEntries(properties: unknown): readonly (readonly [string, unknown])[] {
	if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
	return Object.entries(properties);
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter(isString) : [];
}

function firstLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.split("\n", 1)[0]?.trim();
	return line === undefined || line.length === 0 ? undefined : line;
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function isSchemaLike(value: unknown): value is SchemaLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
