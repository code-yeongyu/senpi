import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { GateInputError } from "./gate-input-error.ts";

export { GateInputError };

const strings = Type.Array(Type.String());
const prompt = Type.Object({
	description: Type.String(),
	promptSnippet: Type.String(),
	promptGuidelines: strings,
	bytes: Type.Number(),
	tokens: Type.Number(),
});
export const reportSchema = Type.Object({
	version: Type.Literal(1),
	prompts: Type.Record(Type.String(), prompt),
	schemas: Type.Record(Type.String(), Type.String()),
	helperCensus: Type.Record(Type.String(), strings),
	runtimes: Type.Array(Type.Object({ id: Type.String(), available: Type.Boolean() })),
	invariants: Type.Record(Type.String(), Type.Unknown()),
	imports: Type.Record(Type.String(), strings),
	observations: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	unmeasured: Type.Optional(strings),
});
export type GateReport = Static<typeof reportSchema>;
export const runtimesSchema = Type.Object({
	version: Type.Literal(1),
	required: Type.Array(
		Type.Object({
			id: Type.String(),
			language: Type.Union([Type.Literal("js"), Type.Literal("py"), Type.Literal("rb"), Type.Literal("jl")]),
			jsRuntime: Type.Optional(Type.Union([Type.Literal("bun"), Type.Literal("node")])),
		}),
		{ minItems: 1 },
	),
});
export const allowlistSchema = Type.Object({
	version: Type.Literal(1),
	nodes: Type.Record(Type.String(), Type.Object({
		additions: strings,
		reason: Type.String(),
		changes: Type.Optional(Type.Array(
			Type.Object({ key: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		)),
	})),
});
export const goldenSchema = Type.Record(Type.String(), strings);

export async function readReport(path: string): Promise<GateReport> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!Check(reportSchema, value)) throw new GateInputError(path);
	return value;
}

/** Object key order is not a JSON contract; string content and array order are. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
