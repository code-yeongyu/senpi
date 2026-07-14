import type { TSchema } from "typebox";
import { IsArray, IsBoolean, IsInteger, IsNumber, IsObject, IsString } from "typebox";
import { Value } from "typebox/value";
import type { Tool } from "../../../types.ts";
import { decodeXmlEntities } from "./xml-entities.ts";

type RawParameter = {
	readonly name: string;
	readonly rawValue: string;
};

type CoercionResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const INVALID: CoercionResult = { ok: false };
const LEADING_RAW_NEWLINE = /^(?:\r\n|\r|\n)/;
const TRAILING_RAW_NEWLINE = /(?:\r\n|\r|\n)$/;

function trimRawBoundaryNewlines(value: string): string {
	return value.replace(LEADING_RAW_NEWLINE, "").replace(TRAILING_RAW_NEWLINE, "");
}

export function coerceParameters(rawParams: readonly RawParameter[], tool: Tool): Record<string, unknown> | null {
	if (!IsObject(tool.parameters)) {
		return null;
	}

	const argumentsRecord: Record<string, unknown> = {};
	for (const rawParam of rawParams) {
		if (Object.hasOwn(argumentsRecord, rawParam.name)) {
			return null;
		}

		const propertySchema = tool.parameters.properties[rawParam.name];
		const rawValue = trimRawBoundaryNewlines(rawParam.rawValue);
		const result = propertySchema
			? coerceKnownValue(rawValue, propertySchema)
			: { ok: true, value: coerceUnknownValue(rawValue) };
		if (!result.ok) {
			return null;
		}

		Object.defineProperty(argumentsRecord, rawParam.name, {
			configurable: true,
			enumerable: true,
			value: result.value,
			writable: true,
		});
	}

	return passesToolValidation(tool, argumentsRecord) ? argumentsRecord : null;
}

function coerceKnownValue(rawValue: string, schema: TSchema): CoercionResult {
	const value = decodeXmlEntities(rawValue);

	if (IsString(schema)) {
		return { ok: true, value };
	}

	if (IsNumber(schema) || IsInteger(schema)) {
		if (value.trim().length === 0) {
			return INVALID;
		}
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || (IsInteger(schema) && !Number.isInteger(parsed))) {
			return INVALID;
		}
		return { ok: true, value: parsed };
	}

	if (IsBoolean(schema)) {
		if (value === "true") {
			return { ok: true, value: true };
		}
		if (value === "false") {
			return { ok: true, value: false };
		}
		return INVALID;
	}

	if (IsArray(schema)) {
		const parsed = tryParseJson(value);
		return parsed.ok && Array.isArray(parsed.value) ? parsed : INVALID;
	}

	if (IsObject(schema)) {
		const parsed = tryParseJson(value);
		return parsed.ok && isJsonObject(parsed.value) ? parsed : INVALID;
	}

	return { ok: true, value: coerceUnknownValue(rawValue) };
}

function coerceUnknownValue(rawValue: string): unknown {
	const value = decodeXmlEntities(rawValue);
	const parsed = tryParseJson(value);
	return parsed.ok ? parsed.value : value;
}

function tryParseJson(value: string): CoercionResult {
	try {
		return { ok: true, value: JSON.parse(value) };
	} catch (error) {
		if (error instanceof SyntaxError) {
			return INVALID;
		}
		throw error;
	}
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function passesToolValidation(tool: Tool, argumentsRecord: Record<string, unknown>): boolean {
	return Value.Check(tool.parameters, argumentsRecord);
}
