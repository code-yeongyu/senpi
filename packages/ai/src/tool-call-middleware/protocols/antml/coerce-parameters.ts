import type { TSchema } from "typebox";
import { IsArray, IsBoolean, IsInteger, IsNumber, IsObject, IsString } from "typebox";
import { Value } from "typebox/value";
import type { Tool } from "../../../types.ts";
import { trimRawBoundaryNewlines } from "../anthropic-xml/coerce-parameters.ts";
import { decodeXmlEntities } from "../anthropic-xml/xml-entities.ts";
import { repairLoneSurrogates, repairStringsDeep, repairUnicodeEscapes } from "./repair.ts";

type RawParameter = {
	readonly name: string;
	readonly rawValue: string;
};

type CoercionResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const INVALID: CoercionResult = { ok: false };

/**
 * Parameter spellings Claude-family models substitute for each other under
 * pressure (mirrors Claude Code's per-tool alias tables). Names inside one
 * group resolve to whichever member the tool schema actually declares.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
	["file_path", "path", "filename", "file"],
	["old_string", "old_str", "old_text"],
	["new_string", "new_str", "new_text"],
	["command", "cmd"],
];

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ALIAS_LOOKUP: ReadonlyMap<string, readonly string[]> = new Map(
	ALIAS_GROUPS.flatMap((group) => group.map((name) => [normalizeName(name), group] as const)),
);

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(record, key, { configurable: true, enumerable: true, value, writable: true });
}

/**
 * Resolves a model-emitted key to a declared schema property: exact match
 * first, then case/separator-insensitive match, then the alias table.
 * Returns undefined for keys the schema does not know (they are filtered).
 */
function resolvePropertyName(rawName: string, properties: Record<string, TSchema>): string | undefined {
	if (Object.hasOwn(properties, rawName)) {
		return rawName;
	}

	const normalized = normalizeName(rawName);
	const byNormalized = Object.keys(properties).filter((property) => normalizeName(property) === normalized);
	if (byNormalized.length === 1) {
		return byNormalized[0];
	}
	if (byNormalized.length > 1) {
		return undefined;
	}

	const aliasGroup = ALIAS_LOOKUP.get(normalized);
	if (!aliasGroup) {
		return undefined;
	}
	const byAlias = Object.keys(properties).filter((property) => {
		const propertyNormalized = normalizeName(property);
		return (
			propertyNormalized !== normalized && aliasGroup.some((alias) => normalizeName(alias) === propertyNormalized)
		);
	});
	return byAlias.length === 1 ? byAlias[0] : undefined;
}

function getAdditionalPropertiesSchema(schema: TSchema): TSchema | true | undefined {
	const additional = (schema as { additionalProperties?: unknown }).additionalProperties;
	if (additional === true) {
		return true;
	}
	if (typeof additional === "object" && additional !== null) {
		return additional as TSchema;
	}
	return undefined;
}

/**
 * Recursively drops object keys a schema does not declare, resolving each key
 * through the same alias table on the way. Repairs only ever narrow a value;
 * the final schema validation decides whether the repaired call is accepted.
 */
function filterUnknownKeysDeep(value: unknown, schema: TSchema): unknown {
	if (IsArray(schema) && Array.isArray(value) && schema.items !== undefined && !Array.isArray(schema.items)) {
		return value.map((entry) => filterUnknownKeysDeep(entry, schema.items as TSchema));
	}

	if (IsObject(schema) && typeof value === "object" && value !== null && !Array.isArray(value)) {
		const properties = schema.properties ?? {};
		const additional = getAdditionalPropertiesSchema(schema);
		const filtered: Record<string, unknown> = {};
		for (const [rawKey, entry] of Object.entries(value)) {
			const propertyName = resolvePropertyName(rawKey, properties);
			if (propertyName !== undefined) {
				const propertySchema = properties[propertyName];
				setOwn(filtered, propertyName, propertySchema ? filterUnknownKeysDeep(entry, propertySchema) : entry);
				continue;
			}
			if (additional === true) {
				setOwn(filtered, rawKey, entry);
			} else if (additional !== undefined) {
				setOwn(filtered, rawKey, filterUnknownKeysDeep(entry, additional));
			}
		}
		return filtered;
	}

	return value;
}

function tryParseJsonTolerant(value: string): CoercionResult {
	for (const candidate of [value, repairUnicodeEscapes(value)]) {
		try {
			return { ok: true, value: repairStringsDeep(JSON.parse(candidate)) };
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				throw error;
			}
		}
	}
	return INVALID;
}

function unwrapJsonScalar(value: string): string {
	const parsed = tryParseJsonTolerant(value.trim());
	return parsed.ok && (typeof parsed.value === "string" || typeof parsed.value === "number")
		? String(parsed.value)
		: value;
}

function coerceKnownValue(rawValue: string, schema: TSchema): CoercionResult {
	const value = decodeXmlEntities(rawValue);

	if (IsString(schema)) {
		return { ok: true, value: repairLoneSurrogates(value) };
	}

	if (IsNumber(schema) || IsInteger(schema)) {
		const candidate = unwrapJsonScalar(value).trim();
		if (candidate.length === 0) {
			return INVALID;
		}
		const parsed = Number(candidate);
		if (!Number.isFinite(parsed) || (IsInteger(schema) && !Number.isInteger(parsed))) {
			return INVALID;
		}
		return { ok: true, value: parsed };
	}

	if (IsBoolean(schema)) {
		const candidate = unwrapJsonScalar(value).trim().toLowerCase();
		if (candidate === "true") {
			return { ok: true, value: true };
		}
		if (candidate === "false") {
			return { ok: true, value: false };
		}
		return INVALID;
	}

	if (IsArray(schema)) {
		const parsed = tryParseJsonTolerant(value);
		return parsed.ok && Array.isArray(parsed.value)
			? { ok: true, value: filterUnknownKeysDeep(parsed.value, schema) }
			: INVALID;
	}

	if (IsObject(schema)) {
		const parsed = tryParseJsonTolerant(value);
		return parsed.ok && typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
			? { ok: true, value: filterUnknownKeysDeep(parsed.value, schema) }
			: INVALID;
	}

	return { ok: true, value: coerceUnknownValue(rawValue) };
}

function coerceUnknownValue(rawValue: string): unknown {
	const value = decodeXmlEntities(rawValue);
	const parsed = tryParseJsonTolerant(value);
	return parsed.ok ? parsed.value : repairLoneSurrogates(value);
}

/**
 * Failure-tolerant ANTML argument coercion. Mirrors the repairs Claude Code
 * applies to model tool calls — parameter aliases, unknown-key filtering,
 * unicode escape repair, lenient scalar spellings, duplicate last-wins —
 * while keeping the strict gate: the repaired record must pass the tool's
 * schema validation or the call is rejected (never a best-effort guess).
 */
export function coerceAntmlParameters(rawParams: readonly RawParameter[], tool: Tool): Record<string, unknown> | null {
	if (!IsObject(tool.parameters)) {
		return null;
	}

	const properties = tool.parameters.properties ?? {};
	const additional = getAdditionalPropertiesSchema(tool.parameters);
	const argumentsRecord: Record<string, unknown> = {};

	for (const rawParam of rawParams) {
		const rawValue = trimRawBoundaryNewlines(rawParam.rawValue);
		const propertyName = resolvePropertyName(rawParam.name, properties);

		if (propertyName === undefined) {
			if (additional === undefined) {
				continue;
			}
			const result =
				additional === true
					? { ok: true as const, value: coerceUnknownValue(rawValue) }
					: coerceKnownValue(rawValue, additional);
			if (result.ok) {
				setOwn(argumentsRecord, rawParam.name, result.value);
			}
			continue;
		}

		const propertySchema = properties[propertyName];
		if (propertySchema === undefined) {
			continue;
		}
		const result = coerceKnownValue(rawValue, propertySchema);
		if (!result.ok) {
			return null;
		}
		setOwn(argumentsRecord, propertyName, result.value);
	}

	return Value.Check(tool.parameters, argumentsRecord) ? argumentsRecord : null;
}
