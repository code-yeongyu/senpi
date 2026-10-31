import { type JsonObject, registerToolArgumentValidator, validateToolArguments } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { EVAL_LANGUAGE_INFERRED_KEY, inferEvalLanguage } from "./eval-language-inference.ts";
import { type EvalRunField, evalRunFieldRequiredMessage, normalizeEvalSummary } from "./eval-request.ts";
import type { EvalLanguage } from "./types.ts";

type EvalArgumentValidator = Parameters<typeof registerToolArgumentValidator>[1];
type EvalArgumentError = NonNullable<EvalArgumentValidator["errors"]>[number];

const RUN_FIELDS: readonly EvalRunField[] = ["language", "code", "summary"];

/**
 * Owns eval argument validation (senpi#5138). A run call (action omitted or "run") missing a run field fails with
 * one teaching error per missing field, before the generic anyOf validation whose per-branch dump a model cannot act
 * on. Every other call goes through the generic validation and coercion unchanged.
 */
export function registerEvalArgumentValidator(schema: TSchema, languages: readonly EvalLanguage[]): void {
	// The same schema under another identity, so the generic path validates it instead of calling back here.
	const generic: TSchema = Object.create(Object.getPrototypeOf(schema), Object.getOwnPropertyDescriptors(schema));
	const compiled = Compile(generic);
	const validate: EvalArgumentValidator = (value) => {
		const inferred = fillInferredLanguage(value, languages);
		const missing = missingRunFieldErrors(value, languages);
		if (missing.length > 0) {
			validate.errors = missing;
			return false;
		}
		try {
			const coerced: unknown = validateToolArguments(
				{ name: "eval", description: "", parameters: generic },
				{ type: "toolCall", id: "", name: "eval", arguments: value as JsonObject },
			);
			// A registered validator's input is what the caller returns, so the generic coercion lands in place.
			if (isRecord(value) && isRecord(coerced)) {
				for (const key of Object.keys(value)) delete value[key];
				Object.assign(value, coerced);
				if (inferred !== undefined) value[EVAL_LANGUAGE_INFERRED_KEY] = inferred;
			}
			validate.errors = null;
			return true;
		} catch {
			validate.errors = [...compiled.Errors(value)];
			return false;
		}
	};
	registerToolArgumentValidator(schema, validate);
}

/**
 * Fills an omitted run language when it is unambiguous (senpi#5154), before the missing-field check, and drops any
 * inference marker the caller sent so only this fill can set it. An explicit language is never changed.
 */
function fillInferredLanguage(value: unknown, languages: readonly EvalLanguage[]): string | undefined {
	if (!isRecord(value) || (value.action !== undefined && value.action !== "run")) return undefined;
	delete value[EVAL_LANGUAGE_INFERRED_KEY];
	if (!isMissing("language", value.language)) return undefined;
	const inference = inferEvalLanguage(value.code, languages);
	if (inference === undefined) return undefined;
	value.language = inference.language;
	return inference.basis;
}

function missingRunFieldErrors(value: unknown, languages: readonly EvalLanguage[]): EvalArgumentError[] {
	if (!isRecord(value) || (value.action !== undefined && value.action !== "run")) return [];
	return RUN_FIELDS.filter((field) => isMissing(field, value[field])).map((field) => ({
		instancePath: "",
		keyword: "required",
		message: evalRunFieldRequiredMessage(field, languages),
		params: { missingProperty: field },
	}));
}

function isMissing(field: EvalRunField, value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return field === "summary" && typeof value === "string" && normalizeEvalSummary(value) === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
