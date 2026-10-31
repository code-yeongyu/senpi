import type { ExtensionContext } from "@code-yeongyu/senpi";
import {
	type EvalControlInput,
	type EvalLanguage,
	type EvalToolInput,
	type EvalToolRequest,
	evalLanguageOrder,
} from "./types.ts";
import {
	EVAL_LANGUAGE_INFERRED_KEY,
	type EvalLanguageInferenceBasis,
	inferEvalLanguage,
	isEvalLanguageInferenceBasis,
} from "./eval-language-inference.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

// A summary is one line of any length: whitespace (including newlines) collapses to single
// spaces, and a blank value counts as absent. The TUI bounds how much of it a collapsed block shows.
export function normalizeEvalSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/\s+/gu, " ");
	return normalized.length === 0 ? undefined : normalized;
}

export class EvalIsolateInvalidError extends TypeError {
	readonly name = "EvalIsolateInvalidError";
	readonly code = "eval_isolate_invalid";

	constructor(reason: string) {
		super(`eval_isolate_invalid: ${reason}`);
	}
}

export function parseEvalRequest(
	params: unknown,
	enabledLanguages: readonly EvalLanguage[] = evalLanguageOrder,
	options: { readonly sandbox?: boolean } = {},
): EvalToolRequest {
	if (!isRecord(params)) throw new TypeError("eval parameters must be an object");
	if (params.action === "list") return { action: "list" };
	if (params.action === "peek" || params.action === "stop") {
		if (typeof params.cell_id !== "string" || params.cell_id.length === 0)
			throw new TypeError(`eval action "${params.action}" requires cell_id`);
		return { action: params.action, cell_id: params.cell_id };
	}
	if (params.action !== undefined && params.action !== "run")
		throw new TypeError(`Unknown eval action "${String(params.action)}"`);
	// An omitted language is filled only when unambiguous (senpi#5154); argument validation may already have filled it.
	const inference = params.language === undefined ? inferEvalLanguage(params.code, enabledLanguages) : undefined;
	const language: unknown = inference?.language ?? params.language;
	if (language === undefined) throw new TypeError(evalRunFieldRequiredMessage("language", enabledLanguages));
	if (!isEvalLanguage(language))
		throw new TypeError(`eval run language must be one of: ${enabledLanguages.join(", ")}`);
	const inferredBy: EvalLanguageInferenceBasis | undefined =
		inference?.basis ??
		(isEvalLanguageInferenceBasis(params[EVAL_LANGUAGE_INFERRED_KEY])
			? params[EVAL_LANGUAGE_INFERRED_KEY]
			: undefined);
	if (typeof params.code !== "string") throw new TypeError(evalRunFieldRequiredMessage("code", enabledLanguages));
	const summary = normalizeEvalSummary(params.summary);
	if (summary === undefined) throw new TypeError(evalRunFieldRequiredMessage("summary", enabledLanguages));
	if (params.on_timeout !== undefined && params.on_timeout !== "detach" && params.on_timeout !== "error")
		throw new TypeError(`Unknown eval on_timeout value "${String(params.on_timeout)}"`);
	if (params.isolate !== undefined && params.isolate !== false) {
		if (params.isolate !== true) throw new EvalIsolateInvalidError("isolate must be true or false");
		if (options.sandbox !== true) {
			throw new EvalIsolateInvalidError("sandbox cells are turned off (set sandbox.enabled in codemode settings)");
		}
		if (language !== "js") throw new EvalIsolateInvalidError('sandbox cells run JavaScript only (language: "js")');
		if (params.reset === true) throw new EvalIsolateInvalidError("a sandbox cell starts fresh; reset does not apply");
	}
	return {
		language,
		code: params.code,
		summary,
		...(params.action === "run" ? { action: "run" as const } : {}),
		...(typeof params.timeout === "number" ? { timeout: params.timeout } : {}),
		...(params.on_timeout === "detach" || params.on_timeout === "error" ? { on_timeout: params.on_timeout } : {}),
		...(typeof params.reset === "boolean" ? { reset: params.reset } : {}),
		...(params.isolate === true ? { isolate: true } : {}),
		...(inferredBy === undefined ? {} : { language_inferred: inferredBy }),
	};
}

export function isEvalControlRequest(request: EvalToolRequest): request is EvalControlInput {
	return request.action === "peek" || request.action === "stop" || request.action === "list";
}

export function evalTimeoutBehavior(input: EvalToolInput, ctx: ExtensionContext): "detach" | "error" {
	if (input.on_timeout !== undefined) return input.on_timeout;
	return NON_INTERACTIVE_MODES.has(ctx.mode) ? "error" : "detach";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isEvalLanguage(value: unknown): value is EvalToolInput["language"] {
	return value === "py" || value === "js" || value === "rb" || value === "jl";
}

export type EvalRunField = "language" | "code" | "summary";

/** The teaching error for a run call missing one of its fields, shared by argument validation and execution. */
export function evalRunFieldRequiredMessage(field: EvalRunField, languages: readonly EvalLanguage[]): string {
	switch (field) {
		case "language":
			return `eval run requires language: one of ${languages.map((language) => `"${language}"`).join(", ")}`;
		case "code":
			return "eval run requires code: the cell body to execute, verbatim";
		case "summary":
			return "eval run requires summary (one line in the user's language): what you are working on and for what purpose";
	}
}
