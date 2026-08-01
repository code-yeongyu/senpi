import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { EvalControlInput, EvalToolInput, EvalToolRequest } from "./types.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

export function parseEvalRequest(params: unknown): EvalToolRequest {
	if (!isRecord(params)) throw new TypeError("eval parameters must be an object");
	if (params.action === "peek" || params.action === "stop") {
		if (typeof params.cell_id !== "string" || params.cell_id.length === 0)
			throw new TypeError(`eval action "${params.action}" requires cell_id`);
		return { action: params.action, cell_id: params.cell_id };
	}
	if (params.action !== undefined && params.action !== "run")
		throw new TypeError(`Unknown eval action "${String(params.action)}"`);
	if (!isEvalLanguage(params.language)) throw new TypeError("eval run requires language");
	if (typeof params.code !== "string") throw new TypeError("eval run requires code");
	if (params.on_timeout !== undefined && params.on_timeout !== "detach" && params.on_timeout !== "error")
		throw new TypeError(`Unknown eval on_timeout value "${String(params.on_timeout)}"`);
	return {
		language: params.language,
		code: params.code,
		...(params.action === "run" ? { action: "run" as const } : {}),
		...(typeof params.title === "string" ? { title: params.title } : {}),
		...(typeof params.timeout === "number" ? { timeout: params.timeout } : {}),
		...(params.on_timeout === "detach" || params.on_timeout === "error" ? { on_timeout: params.on_timeout } : {}),
		...(typeof params.reset === "boolean" ? { reset: params.reset } : {}),
	};
}

export function isEvalControlRequest(request: EvalToolRequest): request is EvalControlInput {
	return request.action === "peek" || request.action === "stop";
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
