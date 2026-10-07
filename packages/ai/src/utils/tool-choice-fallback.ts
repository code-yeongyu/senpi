import type { Api, Model } from "../types.ts";

/** The wire identity a forced tool_choice refusal is remembered under. */
export type ForcedToolChoiceTarget = Pick<Model<Api>, "api" | "provider" | "baseUrl" | "id">;

/**
 * Models that refused a forced tool_choice and then accepted the same request without one, for the
 * life of the process. Later requests to them send no forced choice instead of paying the refused
 * request again (senpi#2218).
 */
const forcedToolChoiceRefusals = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractHttpStatus(error: unknown): number | undefined {
	if (!isRecord(error)) {
		return undefined;
	}

	const status = error.status;
	if (typeof status === "number") {
		return status;
	}

	const response = error.response;
	if (isRecord(response) && typeof response.status === "number") {
		return response.status;
	}

	return undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

/** Marks an error a stream raised in-band, after its 200 response but before any content (senpi#2801). */
const IN_BAND_BEFORE_CONTENT = Symbol.for("senpi.forcedToolChoice.inBandBeforeContent");

function isInBandBeforeContent(error: unknown): boolean {
	return isRecord(error) && (error as Record<PropertyKey, unknown>)[IN_BAND_BEFORE_CONTENT] === true;
}

function markInBandBeforeContent(error: unknown): unknown {
	const marked = isRecord(error) ? error : new Error(errorMessage(error));
	try {
		Object.defineProperty(marked, IN_BAND_BEFORE_CONTENT, { value: true });
	} catch {
		// A frozen error keeps its own identity; it is then judged like any other in-band error.
	}
	return marked;
}

/**
 * A request refusal: the HTTP 400 that rejects the request, or the same refusal a gateway that has
 * already answered 200 (a keepalive stream) sends in-band before any content (senpi#2801).
 */
function isRequestRefusal(error: unknown): boolean {
	const status = extractHttpStatus(error);
	return status === 400 || (status === undefined && isInBandBeforeContent(error));
}

/**
 * Reads `stream` until it has produced content (or ended, or `maxBuffered` contentless events went
 * by), so a refusal a gateway sends in-band after answering 200 is raised while the request can still
 * be retried. Such an error is marked as a request refusal; the events read are replayed in order.
 */
export async function primeStreamUntilContent<T>(
	stream: AsyncIterable<T>,
	hasContent: (event: T) => boolean,
	maxBuffered = 64,
): Promise<AsyncIterable<T>> {
	const iterator = stream[Symbol.asyncIterator]();
	const buffered: T[] = [];
	let ended = false;
	try {
		while (buffered.length < maxBuffered) {
			const next = await iterator.next();
			if (next.done) {
				ended = true;
				break;
			}
			buffered.push(next.value);
			if (hasContent(next.value)) break;
		}
	} catch (error) {
		throw markInBandBeforeContent(error);
	}
	return {
		async *[Symbol.asyncIterator]() {
			try {
				yield* buffered;
				if (ended) return;
				while (true) {
					const next = await iterator.next();
					if (next.done) return;
					yield next.value;
				}
			} finally {
				if (!ended) await iterator.return?.();
			}
		},
	};
}

export function isForcedToolChoiceUnsupportedError(error: unknown, sentForcedToolChoice: boolean): boolean {
	if (!sentForcedToolChoice || !isRequestRefusal(error)) {
		return false;
	}

	const message = errorMessage(error);
	return (
		/tool[_\s-]?choices?\b.*?(not\s+(?:currently\s+)?compatible|incompatible|not\s+(?:currently\s+)?supported|unsupported)/is.test(
			message,
		) ||
		/forces?\s+tool\s+use.*?(not\s+(?:currently\s+)?compatible|incompatible|not\s+(?:currently\s+)?supported|unsupported)/is.test(
			message,
		) ||
		/does\s+not\s+support\s+forced\s+tool[_\s-]?choices?/is.test(message) ||
		// Auto-only tool-choice upstreams. OmniRoute serving opencode-go/muse-spark-1.3-contributor
		// (2026-09-27): "only `\"auto\"` is supported for `tool_choice`. `\"none\"`, `\"required\"`, and named
		// function choices are not currently supported". Kiro behind an OpenAI-compatible proxy
		// (senpi#2218): "Kiro supports only automatic tool choice or tool_choice:none".
		/\bonly\s+[`"]*auto(?:matic)?[`"]*\s.{0,40}?tool[_\s-]?choice/is.test(message) ||
		// Anthropic Messages with extended thinking on: "Thinking may not be enabled when tool_choice forces tool use."
		/thinking\s+may\s+not\s+be\s+enabled\s+when\s+tool[_\s-]?choice\s+forces\s+tool\s+use/is.test(message) ||
		// OpenAI-compatible gateways serving always-thinking Claude models (observed on opengateway for
		// claude-fable-5-1, 2026-09-24): "This model always runs with thinking enabled, so tool_choice
		// cannot force tool use. Use tool_choice 'auto' or 'none'."
		/tool[_\s-]?choice\s+cannot\s+force\s+tool\s+use/is.test(message)
	);
}

/** The tool a `tool_choice` forces, in the wire shapes senpi sends (Chat Completions, Responses, Messages). */
function forcedToolName(toolChoice: unknown): string | undefined {
	if (!isRecord(toolChoice)) return undefined;
	const named = isRecord(toolChoice.function) ? toolChoice.function.name : toolChoice.name;
	return typeof named === "string" && named.length > 0 ? named : undefined;
}

function toolNames(tools: unknown): readonly (string | undefined)[] {
	if (!Array.isArray(tools)) return [];
	return tools.map((tool) => {
		if (!isRecord(tool)) return undefined;
		const named = isRecord(tool.function) ? tool.function.name : tool.name;
		return typeof named === "string" ? named : undefined;
	});
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A 400 to a request that forced a tool and whose message names that very tool: its `tools.N` /
 * `tools[N]` position or its quoted name. Strict-schema gateways refuse the forced tool's schema this
 * way (senpi#2648); the same request without the forced choice is accepted. A 400 that names
 * no tool, or another one, is not this refusal.
 */
export function refusalNamesForcedTool(
	error: unknown,
	params: { readonly tool_choice?: unknown; readonly tools?: unknown },
): boolean {
	if (!isRequestRefusal(error)) return false;
	const name = forcedToolName(params.tool_choice);
	if (name === undefined) return false;
	const message = errorMessage(error);
	const index = toolNames(params.tools).indexOf(name);
	if (index >= 0 && new RegExp(`\\btools(?:\\.${index}|\\[${index}\\])(?!\\d)`).test(message)) return true;
	return new RegExp(`['"\`]${escapeRegExp(name)}['"\`]`).test(message);
}

export function omitToolChoiceParam<TParams extends { tool_choice?: unknown }>(params: TParams): TParams {
	const nextParams = { ...params };
	delete nextParams.tool_choice;
	return nextParams;
}

function refusalKey(target: ForcedToolChoiceTarget): string {
	return JSON.stringify([target.api, target.provider, target.baseUrl, target.id]);
}

/** Whether `target` refused a forced tool_choice earlier in this process. */
export function hasRefusedForcedToolChoice(target: ForcedToolChoiceTarget): boolean {
	return forcedToolChoiceRefusals.has(refusalKey(target));
}

/** Forgets every remembered refusal; tests isolate their models with it. */
export function clearForcedToolChoiceRefusals(): void {
	forcedToolChoiceRefusals.clear();
}

export type ForcedToolChoiceRequest<TParams extends { tool_choice?: unknown }, TResult> = {
	readonly target: ForcedToolChoiceTarget;
	readonly params: TParams;
	/** The model's declared capability (`compat.supportsForcedToolChoice`, default true). */
	readonly acceptsForcedToolChoice: boolean;
	readonly isForced: (toolChoice: TParams["tool_choice"]) => boolean;
	readonly send: (params: TParams) => Promise<TResult>;
};

/**
 * Sends a request whose `tool_choice` may force a tool. A model declared or remembered as refusing
 * forced choices gets the request without `tool_choice` up front. Otherwise a 400 refusing the forced
 * choice is retried once without it, and the model is remembered once that retry is accepted, unless
 * the refusal blamed thinking; a retry that fails too surfaces its own error and records nothing.
 */
export async function sendWithForcedToolChoiceFallback<TParams extends { tool_choice?: unknown }, TResult>(
	request: ForcedToolChoiceRequest<TParams, TResult>,
): Promise<{ readonly params: TParams; readonly result: TResult }> {
	const forced = request.isForced(request.params.tool_choice);
	if (forced && (!request.acceptsForcedToolChoice || hasRefusedForcedToolChoice(request.target))) {
		const params = omitToolChoiceParam(request.params);
		return { params, result: await request.send(params) };
	}
	try {
		return { params: request.params, result: await request.send(request.params) };
	} catch (error) {
		if (
			!isForcedToolChoiceUnsupportedError(error, forced) &&
			!(forced && refusalNamesForcedTool(error, request.params))
		)
			throw error;
		const params = omitToolChoiceParam(request.params);
		const result = await request.send(params);
		// A refusal that names thinking depends on the request's thinking setting, not on the model alone.
		if (!/thinking/i.test(errorMessage(error))) forcedToolChoiceRefusals.add(refusalKey(request.target));
		return { params, result };
	}
}
