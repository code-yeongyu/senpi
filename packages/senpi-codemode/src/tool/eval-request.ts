import type { ExtensionContext } from "@code-yeongyu/senpi";
import {
	type EvalControlInput,
	type EvalLanguage,
	type EvalToolInput,
	type EvalToolRequest,
	evalLanguageOrder,
} from "./types.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

// A summary is one line of any length: whitespace (including newlines) collapses to single
// spaces, and a blank value counts as absent. The TUI bounds how much of it a collapsed block shows.
export function normalizeEvalSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/\s+/gu, " ");
	return normalized.length === 0 ? undefined : normalized;
}

export function parseEvalRequest(
	params: unknown,
	enabledLanguages: readonly EvalLanguage[] = evalLanguageOrder,
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
	if (params.language === undefined) throw new TypeError(evalRunRequiresLanguageMessage(enabledLanguages));
	if (!isEvalLanguage(params.language))
		throw new TypeError(`eval run language must be one of: ${evalLanguageOrder.join(", ")}`);
	if (typeof params.code !== "string")
		throw new TypeError("eval run requires code — the cell body to execute, verbatim");
	const summary = normalizeEvalSummary(params.summary);
	if (summary === undefined)
		throw new TypeError(
			"eval run requires summary — one line in the user's language: what you are working on and for what purpose",
		);
	if (params.on_timeout !== undefined && params.on_timeout !== "detach" && params.on_timeout !== "error")
		throw new TypeError(`Unknown eval on_timeout value "${String(params.on_timeout)}"`);
	return {
		language: params.language,
		code: params.code,
		summary,
		...(params.action === "run" ? { action: "run" as const } : {}),
		...(typeof params.timeout === "number" ? { timeout: params.timeout } : {}),
		...(params.on_timeout === "detach" || params.on_timeout === "error" ? { on_timeout: params.on_timeout } : {}),
		...(typeof params.reset === "boolean" ? { reset: params.reset } : {}),
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

function evalRunRequiresLanguageMessage(languages: readonly EvalLanguage[]): string {
	return `eval run requires language — one of ${languages.map((language) => `"${language}"`).join(", ")}`;
}
