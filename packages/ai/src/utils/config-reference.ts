import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { ConfigReferenceError } from "./config-reference-error.ts";

export { ConfigReferenceError, type ConfigReferenceReason } from "./config-reference-error.ts";

const FileReferenceSchema = Type.Object({ $file: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const EnvReferenceSchema = Type.Object(
	{ $env: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }) },
	{ additionalProperties: false },
);
const ConcatReferenceSchema = Type.Object(
	{ $concat: Type.Array(Type.Union([Type.String(), FileReferenceSchema, EnvReferenceSchema])) },
	{ additionalProperties: false },
);

export const ConfigReferenceSchema = Type.Union([FileReferenceSchema, EnvReferenceSchema, ConcatReferenceSchema]);
export const ConfigValueSchema = Type.Union([Type.String(), ConfigReferenceSchema]);
export const NonemptyConfigValueSchema = Type.Union([Type.String({ minLength: 1 }), ConfigReferenceSchema]);
export type ConfigReference = Static<typeof ConfigReferenceSchema>;
export type ConfigValue = string | ConfigReference;

const validateReference = Compile(ConfigReferenceSchema);

export function isConfigReference(value: unknown): value is ConfigReference {
	return validateReference.Check(value);
}

/** Used only at declared string-value boundaries, never on opaque JSON fields. */
export function assertConfigValue(value: unknown, field: string): asserts value is ConfigValue {
	if (typeof value !== "string" && !isConfigReference(value)) {
		throw new ConfigReferenceError(field, value, "malformed");
	}
}
