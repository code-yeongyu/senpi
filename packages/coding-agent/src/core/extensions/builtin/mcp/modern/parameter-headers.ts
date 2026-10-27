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

function parseParameterHeaders(schema: unknown): readonly ParameterHeader[] | string {
	const headers: ParameterHeader[] = [];
	const names = new Set<string>();
	let reason = "";
	const visit = (node: unknown, path: readonly string[] | undefined): boolean => {
		if (Array.isArray(node)) return node.every((child) => visit(child, undefined));
		if (!isRecord(node)) return true;
		if (Object.hasOwn(node, "x-mcp-header")) {
			const name = node["x-mcp-header"];
			const type = node.type;
			if (!path?.length) reason = "x-mcp-header must be on a properties-only path";
			else if (typeof name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
				reason = "x-mcp-header must be a nonempty HTTP field-name token";
			else if (names.has(name.toLowerCase())) reason = "x-mcp-header names must be case-insensitively unique";
			else if (type !== "string" && type !== "integer" && type !== "boolean")
				reason = "x-mcp-header type must be string, integer, or boolean";
			else {
				names.add(name.toLowerCase());
				headers.push({ name, path, type });
			}
			if (reason) return false;
		}
		// "Anywhere else" includes unknown keywords; instance-data keywords are not schemas.
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
			} else if (!["examples", "default", "const", "enum"].includes(keyword)) {
				if (!visit(value, undefined)) return false;
			}
		}
		return true;
	};
	return visit(schema, []) ? headers : reason;
}

/** A local argument error, not a failed transport or an untrusted server diagnostic. */
export class ParameterHeaderValidationError extends Error {}

/** Connection-local catalog: never shared with another server or transport generation. */
export class ModernParameterHeaders {
	readonly #tools = new Map<string, readonly ParameterHeader[]>();

	filterTools(tools: readonly unknown[], firstPage: boolean, warn: (message: string) => void): unknown[] {
		if (firstPage) this.#tools.clear();
		return tools.filter((tool) => {
			if (!isRecord(tool) || typeof tool.name !== "string") return true;
			const headers = parseParameterHeaders(tool.inputSchema);
			if (typeof headers === "string") {
				this.#tools.delete(tool.name);
				warn(`Rejected MCP tool ${JSON.stringify(tool.name)}: ${headers}`);
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
			if (value === undefined) continue;
			const valid =
				(parameter.type === "string" && typeof value === "string") ||
				(parameter.type === "boolean" && typeof value === "boolean") ||
				(parameter.type === "integer" && typeof value === "number" && Number.isSafeInteger(value));
			if (!valid) {
				throw new ParameterHeaderValidationError(
					`MCP tool ${JSON.stringify(name)} argument ${JSON.stringify(parameter.path)} must be ${parameter.type === "integer" ? "a safe integer" : `a ${parameter.type}`}`,
				);
			}
			headers.set(`Mcp-Param-${parameter.name}`, encodeMcpHeaderValue(String(value)));
		}
	}
}
