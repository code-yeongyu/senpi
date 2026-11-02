import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** The fields of a tool that decide what a call means: what the model is shown and how the executor runs it. */
export type CatalogTool = Pick<AgentTool, "name" | "description" | "parameters" | "outputSchema" | "executionMode">;

/** A tool's schema holds a value with no single JSON spelling, so no digest can stand for it. */
export class CatalogSchemaError extends Error {
	readonly name = "CatalogSchemaError";
	readonly toolName: string;
	readonly path: string;

	constructor(toolName: string, path: string, reason: string) {
		super(`tool "${toolName}" cannot be digested: ${reason} at ${path}`);
		this.toolName = toolName;
		this.path = path;
	}
}

function isPlainObject(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * One spelling per JSON value: object keys sorted, keys whose value is `undefined` left out, array order kept.
 * Anything JSON cannot carry (functions, symbols, bigints, non-finite numbers, class instances, cycles) throws,
 * because two processes could not agree on its bytes.
 */
function canonicalJson(toolName: string, value: unknown, path: string, open: Set<object>): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CatalogSchemaError(toolName, path, "a non-finite number");
		return JSON.stringify(value);
	}
	if (typeof value !== "object") throw new CatalogSchemaError(toolName, path, `a ${typeof value} value`);
	if (open.has(value)) throw new CatalogSchemaError(toolName, path, "a cycle");
	open.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map((item, index) => canonicalJson(toolName, item, `${path}[${index}]`, open)).join(",")}]`;
		}
		if (!isPlainObject(value)) throw new CatalogSchemaError(toolName, path, "a class instance");
		const fields = Object.keys(value)
			.sort()
			.flatMap((key) => {
				const field: unknown = Reflect.get(value, key);
				if (field === undefined) return [];
				return [`${JSON.stringify(key)}:${canonicalJson(toolName, field, `${path}.${key}`, open)}`];
			});
		return `{${fields.join(",")}}`;
	} finally {
		open.delete(value);
	}
}

/**
 * The 32-byte SHA-256 digest (hex) of one tool's registered schema. A call names the digest it was built
 * against, so a change to this tool makes that call stale while a change to any other tool does not.
 */
export function toolSchemaDigest(tool: CatalogTool): string {
	const material = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		outputSchema: tool.outputSchema,
		executionMode: tool.executionMode,
	};
	return createHash("sha256")
		.update(canonicalJson(tool.name, material, "$", new Set()))
		.digest("hex");
}
