import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Model,
	type ProviderDiagnostic,
	type ProviderDiagnosticCategory,
	sanitizeProviderDiagnostic,
} from "@earendil-works/pi-ai";
import { type FallbackModelLookup, parseFallbackSelector } from "./retry-fallback/chains.ts";

/**
 * `request_refused`: an `auth` failure on a credential that served a response moments before, so the
 * provider refused this request rather than the key (senpi#2491).
 * `model_unavailable`: an `unknown` failure the provider answered with HTTP 404, the status a model
 * endpoint returns for a model id this account cannot use (senpi#4578).
 */
export type ProviderFailureCategory = ProviderDiagnosticCategory | "request_refused" | "model_unavailable";

/**
 * Structured failure of a turn that ended with a provider error, attached to `agent_end`.
 * Built only from the adapter-minted `ProviderDiagnostic` and the runtime's typed served-credential
 * mark; message text is never read.
 * Every category, `unknown` included, carries a reason and an action.
 */
export interface ProviderFailure {
	readonly category: ProviderFailureCategory;
	/** Provider id of the failing request. */
	readonly provider: string;
	/** Model id of the failing request (senpi#4328). */
	readonly model?: string;
	/**
	 * The provider and model the user selected, present (both) only when the failing request ran on
	 * another one: a fallback rung, or the route a virtual model picked (senpi#4328).
	 */
	readonly selectedProvider?: string;
	readonly selectedModel?: string;
	readonly httpStatus?: number;
	readonly code?: string;
	/** When the limit lifts (epoch ms), for a `quota` or `rate_limit` failure whose provider named it. */
	readonly resetsAt?: number;
	readonly reason: string;
	readonly action: string;
}

const ACTIONS: Record<Exclude<ProviderFailureCategory, "unknown">, { reason: string; action: string }> = {
	auth: { reason: "the provider rejected the credentials", action: "re-authenticate the provider" },
	request_refused: {
		reason: "the provider refused this request, but the same key worked moments ago, so it may still be valid",
		action: "send the message again or choose another model; if it keeps failing, re-authenticate",
	},
	model_unavailable: {
		reason: "the model is not available for this account",
		action: "choose another model, or check that your plan or key includes this model",
	},
	rate_limit: { reason: "the provider is rate limiting requests", action: "retry later or set a fallback model" },
	quota: { reason: "the provider account is out of quota", action: "check the plan or credits" },
	context_limit: {
		reason: "the conversation is larger than the model's context",
		action: "compact or shorten the conversation",
	},
	invalid_request: {
		reason: "the provider could not accept this request",
		action: "send the message again; if it repeats, choose another model or start a new session",
	},
	provider_unavailable: { reason: "the provider is unavailable", action: "retry or switch provider" },
	network: { reason: "the connection to the provider failed", action: "check connectivity" },
};

/** An `auth` failure on a credential that served a response moments before: the request was refused, not the key. */
export function isRequestLevelRefusal(message: AssistantMessage): boolean {
	return (
		message.credentialServedRecently === true &&
		sanitizeProviderDiagnostic(message.providerDiagnostic)?.category === "auth"
	);
}

/** The provider and model a turn was meant to run on. */
export interface SelectedModel {
	readonly provider: string;
	readonly model: string;
}

/**
 * The model the user selected for this turn: the original of an active fallback chain, else the
 * session model (which stays the virtual model when one routes the request).
 */
export function selectedModelOf(
	originalSelector: string | undefined,
	lookup: FallbackModelLookup,
	sessionModel: Model<Api> | undefined,
): SelectedModel | undefined {
	const original = originalSelector === undefined ? undefined : parseFallbackSelector(originalSelector, lookup);
	if (original !== undefined) return { provider: original.provider, model: original.id };
	return sessionModel === undefined ? undefined : { provider: sessionModel.provider, model: sessionModel.id };
}

export function describeProviderFailure(
	diagnostic: ProviderDiagnostic | undefined,
	provider: string,
	options: { readonly model?: string; readonly requestRefused?: boolean } = {},
): ProviderFailure {
	const category: ProviderFailureCategory = options.requestRefused
		? "request_refused"
		: diagnostic?.category === "unknown" && diagnostic.httpStatus === 404
			? "model_unavailable"
			: (diagnostic?.category ?? "unknown");
	const detail =
		category === "unknown"
			? {
					reason: "the provider returned an unexpected error",
					action: "send the message again; if it repeats, choose another model",
				}
			: ACTIONS[category];
	const resetsAt = diagnostic?.resetsAt;
	return {
		category,
		provider,
		...(options.model === undefined ? {} : { model: options.model }),
		...(diagnostic?.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
		...(diagnostic?.code === undefined ? {} : { code: diagnostic.code }),
		...(resetsAt === undefined ? {} : { resetsAt }),
		...detail,
		...(category === "request_refused" ? { action: `${detail.action} ${provider}` } : {}),
		...(resetsAt === undefined
			? {}
			: {
					reason: `${detail.reason} until ${new Date(resetsAt).toLocaleString("en-US", {
						year: "numeric",
						month: "short",
						day: "numeric",
						hour: "numeric",
						minute: "2-digit",
						timeZoneName: "short",
					})}`,
				}),
	};
}

/**
 * The failure of a turn whose last assistant message ended with `stopReason: "error"`.
 * Absent on success and on abort.
 */
export function providerFailureOf(
	messages: readonly AgentMessage[],
	selected?: SelectedModel,
): ProviderFailure | undefined {
	const last = messages.findLast((message) => message.role === "assistant");
	if (last === undefined || last.role !== "assistant" || last.stopReason !== "error") return undefined;
	const failure = describeProviderFailure(sanitizeProviderDiagnostic(last.providerDiagnostic), last.provider, {
		model: last.model,
		requestRefused: isRequestLevelRefusal(last),
	});
	if (selected === undefined || (selected.provider === last.provider && selected.model === last.model)) {
		return failure;
	}
	return { ...failure, selectedProvider: selected.provider, selectedModel: selected.model };
}

export function formatProviderFailure(failure: ProviderFailure): string {
	const route = failure.model === undefined ? failure.provider : `${failure.model} on ${failure.provider}`;
	const selected =
		failure.selectedProvider === undefined || failure.selectedModel === undefined
			? ""
			: ` (selected: ${failure.selectedModel} on ${failure.selectedProvider})`;
	return `${route}${selected} failed: ${failure.reason}. Action: ${failure.action}.`;
}
