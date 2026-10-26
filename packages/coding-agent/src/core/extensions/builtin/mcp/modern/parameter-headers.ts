import { Buffer } from "node:buffer";

type ParameterHeader = {
	readonly name: string;
	readonly path: readonly string[];
	readonly type: "string" | "integer" | "boolean";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** RFC 9110 field values, preserving whitespace and literal sentinel strings. */
export function encodeMcpHeaderValue(value: string): string {
	return /^[\x09\x20-\x7e]*$/.test(value) &&
		value.trim() === value &&
		!(value.startsWith("=?base64?") && value.endsWith("?="))
		? value
		: `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Configured headers must never supply parameter metadata absent from the request body. */
export function clearMcpParameterHeaders(headers: Headers): void {
	for (const name of [...headers.keys()]) {
		if (name.toLowerCase().startsWith("mcp-param-")) headers.delete(name);
	}
}

function parseParameterHeaders(schema: unknown): readonly ParameterHeader[] | undefined {
	const headers: ParameterHeader[] = [];
	const names = new Set<string>();
	const visit = (node: unknown, path: readonly string[] | undefined): boolean => {
		if (!isRecord(node)) return true;
		if (Object.hasOwn(node, "x-mcp-header")) {
			const name = node["x-mcp-header"];
			const type = node.type;
			if (
				!path?.length ||
				typeof name !== "string" ||
				!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
				names.has(name.toLowerCase()) ||
				(type !== "string" && type !== "integer" && type !== "boolean")
			)
				return false;
			names.add(name.toLowerCase());
			headers.push({ name, path, type });
		}
		// Only schema-valued keywords are traversed: examples/default/const are instance data.
		for (const [keyword, value] of Object.entries(node)) {
			if (
				["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"].includes(
					keyword,
				)
			) {
				if (!isRecord(value)) continue;
				for (const [key, child] of Object.entries(value)) {
					const childPath = keyword === "properties" && path !== undefined ? [...path, key] : undefined;
					if (!visit(child, childPath)) return false;
				}
			} else if (
				[
					"items",
					"prefixItems",
					"allOf",
					"anyOf",
					"oneOf",
					"additionalItems",
					"additionalProperties",
					"unevaluatedItems",
					"unevaluatedProperties",
					"contains",
					"propertyNames",
					"not",
					"if",
					"then",
					"else",
					"contentSchema",
				].includes(keyword)
			) {
				for (const child of Array.isArray(value) ? value : [value]) {
					if (!visit(child, undefined)) return false;
				}
			}
		}
		return true;
	};
	return visit(schema, []) ? headers : undefined;
}

/** Connection-local catalog: never shared with another server or transport generation. */
export class ModernParameterHeaders {
	readonly #tools = new Map<string, readonly ParameterHeader[]>();

	filterTools(tools: readonly unknown[], firstPage: boolean): unknown[] {
		if (firstPage) this.#tools.clear();
		return tools.filter((tool) => {
			if (!isRecord(tool) || typeof tool.name !== "string") return true;
			const headers = parseParameterHeaders(tool.inputSchema);
			if (headers === undefined) {
				this.#tools.delete(tool.name);
				return false;
			}
			this.#tools.set(tool.name, headers);
			return true;
		});
	}

	append(headers: Headers, name: unknown, args: unknown): void {
		if (typeof name !== "string") return;
		for (const parameter of this.#tools.get(name) ?? []) {
			let value = args;
			for (const key of parameter.path) {
				value = isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
			}
			const valid =
				(parameter.type === "string" && typeof value === "string") ||
				(parameter.type === "boolean" && typeof value === "boolean") ||
				(parameter.type === "integer" && typeof value === "number" && Number.isSafeInteger(value));
			if (valid) headers.set(`Mcp-Param-${parameter.name}`, encodeMcpHeaderValue(String(value)));
		}
	}
}
