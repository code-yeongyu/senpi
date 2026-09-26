import type { KernelPreludeContribution } from "@code-yeongyu/senpi";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

const schemaArgsSchema = Type.Object(
	{ name: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);

type SchemaArgs = Static<typeof schemaArgsSchema>;

export interface EvalSchemaToolInfo {
	readonly name: string;
	readonly description?: string | undefined;
	readonly parameters?: unknown;
	readonly kernelPrelude?: KernelPreludeContribution | undefined;
}

export interface RunEvalSchemaOptions {
	readonly listTools: () => readonly EvalSchemaToolInfo[];
}

export type EvalSchemaResult =
	| { readonly tools: readonly string[] }
	| { readonly name: string; readonly description: string | undefined; readonly parameters: unknown };

class SchemaArgumentsError extends Error {
	readonly name = "SchemaArgumentsError";

	constructor(summary: string) {
		super(`schema() received invalid arguments: ${summary}`);
	}
}

class SchemaUnknownToolError extends Error {
	readonly name = "SchemaUnknownToolError";

	constructor(requested: string, suggestions: readonly string[]) {
		const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
		super(`schema() found no tool named "${requested}".${hint}`);
	}
}

export function runEvalSchema(args: unknown, options: RunEvalSchemaOptions): EvalSchemaResult {
	const parsed = parseSchemaArgs(args);
	const tools = options.listTools();
	if (parsed.name === undefined) return { tools: tools.map((tool) => tool.name) };

	const match = tools.find((tool) => tool.name === parsed.name);
	if (match) return { name: match.name, description: match.description, parameters: match.parameters };
	throw new SchemaUnknownToolError(parsed.name, nearestNames(parsed.name, tools));
}

function parseSchemaArgs(value: unknown): SchemaArgs {
	if (Check(schemaArgsSchema, value)) return value;
	const summary = Errors(schemaArgsSchema, value)
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	throw new SchemaArgumentsError(summary || "invalid value");
}

function nearestNames(requested: string, tools: readonly EvalSchemaToolInfo[]): readonly string[] {
	const needle = requested.toLowerCase();
	return tools
		.map((tool) => tool.name)
		.filter((name) => {
			const candidate = name.toLowerCase();
			return candidate.includes(needle) || needle.includes(candidate);
		})
		.slice(0, 5);
}
