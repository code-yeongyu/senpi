import type { ProviderDiagnostic } from "../provider-diagnostic.ts";
import { attachProviderDiagnostic } from "./provider-diagnostic-carrier.ts";
import {
	buildProviderDiagnostic,
	categoryForTransportCode,
	classifyProviderFailure,
} from "./provider-diagnostic-vocabulary.ts";

/** Largest SSE error envelope parsed for classification at all. */
const SSE_ERROR_ENVELOPE_MAX_BYTES = 8_192;

type ErrorClassifier = (error: unknown) => ProviderDiagnostic | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" ? value : null;
}

/**
 * Anthropic SDK `APIError`: reads `status`, the direct `type`, and the body's
 * nested `error.type` once each. Direct and nested tokens that disagree, or a
 * non-string token, yield nothing. Message, headers and request id are never read.
 */
export function anthropicProviderDiagnosticFromError(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		const status = Reflect.get(error, "status");
		const direct = optionalString(Reflect.get(error, "type"));
		const body = Reflect.get(error, "error");
		const nested = isRecord(body) && isRecord(body.error) ? optionalString(body.error.type) : undefined;
		if (direct === null || nested === null) return undefined;
		if (direct !== undefined && nested !== undefined && direct !== nested) return undefined;
		const code = direct ?? nested;
		if (code === undefined && (status === undefined || status === null)) return undefined;
		return classifyProviderFailure({ status, code });
	} catch {
		return undefined;
	}
}

/** Anthropic explicit `event: error` envelope, classified before it collapses into an Error message. */
export function anthropicProviderDiagnosticFromSseData(data: string): ProviderDiagnostic | undefined {
	try {
		if (new TextEncoder().encode(data).length > SSE_ERROR_ENVELOPE_MAX_BYTES) return undefined;
		const parsed: unknown = JSON.parse(data);
		if (!isRecord(parsed) || parsed.type !== "error" || !isRecord(parsed.error)) return undefined;
		const code = parsed.error.type;
		if (typeof code !== "string") return undefined;
		return classifyProviderFailure({ status: undefined, code });
	} catch {
		return undefined;
	}
}

/**
 * OpenAI SDK `APIError` (HTTP rejection or in-stream error chunk): reads
 * `status` and `code` once each. `type` is ignored because OpenAI-compatible
 * servers reuse it for coarse buckets that can contradict the precise code.
 */
export function openAICompatibleProviderDiagnosticFromError(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		const status = Reflect.get(error, "status");
		const code = optionalString(Reflect.get(error, "code"));
		if (code === null) return undefined;
		if (code === undefined && (status === undefined || status === null)) return undefined;
		return classifyProviderFailure({ status, code });
	} catch {
		return undefined;
	}
}

/**
 * A connection failure carries no HTTP status; it proves only that the request got
 * no provider answer. Reads the error's own `code`, then `cause.code` (fetch
 * wraps the socket error), against a closed allowlist. Messages are never read.
 */
/** How many `cause` links a transport code is looked for through (the error itself counts as one). */
const TRANSPORT_CAUSE_DEPTH = 4;

export function transportProviderDiagnosticFromError(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		// SDK errors wrap the runtime's error: Bun puts the code one cause down, Node's fetch two
		// (SDK error -> TypeError "fetch failed" -> { code }). Walk a bounded chain, reading only `code`;
		// the SDK's own connection error class name is the fallback when no link carries a code.
		let current: unknown = error;
		let sdkConnectionError: string | undefined;
		for (let depth = 0; depth < TRANSPORT_CAUSE_DEPTH && (isRecord(current) || current instanceof Error); depth++) {
			const code = Reflect.get(current, "code");
			if (typeof code === "string" && categoryForTransportCode(code) !== undefined)
				return buildProviderDiagnostic({ category: "network", code, evidence: "structured_transport" });
			// The SDKs keep `name` as "Error"; their class is what says connection error.
			for (const name of current instanceof Error ? [current.name, current.constructor.name] : []) {
				if (sdkConnectionError === undefined && categoryForTransportCode(name) !== undefined)
					sdkConnectionError = name;
			}
			current = Reflect.get(current, "cause");
		}
		return sdkConnectionError === undefined
			? undefined
			: buildProviderDiagnostic({ category: "network", code: sdkConnectionError, evidence: "structured_transport" });
	} catch {
		return undefined;
	}
}

function classifyWithTransport(classify: ErrorClassifier, error: unknown): ProviderDiagnostic | undefined {
	return classify(error) ?? transportProviderDiagnosticFromError(error);
}

/**
 * Await one provider transport call and, if it rejects, attach the classifier's
 * verdict to the rejection. Only errors raised by the wrapped call are
 * classified, so caller callbacks and local failures never gain provider provenance.
 */
export async function awaitProviderTransport<T>(request: () => Promise<T>, classify: ErrorClassifier): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (typeof error === "object" && error !== null)
			attachProviderDiagnostic(error, classifyWithTransport(classify, error));
		throw error;
	}
}

/** Iterate a provider SDK stream, attaching the classifier's verdict to any error the stream itself raises. */
export async function* iterateProviderTransport<T>(
	source: AsyncIterable<T>,
	classify: ErrorClassifier,
): AsyncGenerator<T> {
	try {
		yield* source;
	} catch (error) {
		if (typeof error === "object" && error !== null)
			attachProviderDiagnostic(error, classifyWithTransport(classify, error));
		throw error;
	}
}
