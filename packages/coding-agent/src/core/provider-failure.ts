import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ProviderDiagnostic,
	type ProviderDiagnosticCategory,
	sanitizeProviderDiagnostic,
} from "@earendil-works/pi-ai";

/**
 * Structured failure of a turn that ended with a provider error, attached to `agent_end`.
 * Built only from the adapter-minted `ProviderDiagnostic`; message text is never read.
 * Every category, `unknown` included, carries a reason and an action.
 */
export interface ProviderFailure {
	readonly category: ProviderDiagnosticCategory;
	readonly provider: string;
	readonly httpStatus?: number;
	readonly code?: string;
	readonly reason: string;
	readonly action: string;
}

const ACTIONS: Record<Exclude<ProviderDiagnosticCategory, "unknown">, { reason: string; action: string }> = {
	auth: { reason: "the provider rejected the credentials", action: "re-authenticate the provider" },
	rate_limit: { reason: "the provider is rate limiting requests", action: "retry later or set a fallback model" },
	quota: { reason: "the provider account is out of quota", action: "check the plan or credits" },
	context_limit: {
		reason: "the conversation is larger than the model's context",
		action: "compact or shorten the conversation",
	},
	invalid_request: { reason: "the provider rejected the request as invalid", action: "report it with the code" },
	provider_unavailable: { reason: "the provider is unavailable", action: "retry or switch provider" },
	network: { reason: "the connection to the provider failed", action: "check connectivity" },
};

function identifier(diagnostic: ProviderDiagnostic | undefined): string {
	if (diagnostic?.code !== undefined) return `code ${diagnostic.code}`;
	if (diagnostic?.httpStatus !== undefined) return `status ${diagnostic.httpStatus}`;
	return "no code";
}

export function describeProviderFailure(diagnostic: ProviderDiagnostic | undefined, provider: string): ProviderFailure {
	const category = diagnostic?.category ?? "unknown";
	const detail =
		category === "unknown"
			? {
					reason: `the provider returned an error that could not be classified (${provider}, ${identifier(diagnostic)})`,
					action: "retry once; if it repeats, switch the model or report the code",
				}
			: ACTIONS[category];
	return {
		category,
		provider,
		...(diagnostic?.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
		...(diagnostic?.code === undefined ? {} : { code: diagnostic.code }),
		...detail,
	};
}

/**
 * The failure of a turn whose last assistant message ended with `stopReason: "error"`.
 * Absent on success and on abort.
 */
export function providerFailureOf(messages: readonly AgentMessage[]): ProviderFailure | undefined {
	const last = messages.findLast((message) => message.role === "assistant");
	if (last === undefined || last.role !== "assistant" || last.stopReason !== "error") return undefined;
	return describeProviderFailure(sanitizeProviderDiagnostic(last.providerDiagnostic), last.provider);
}

export function formatProviderFailure(failure: ProviderFailure): string {
	return `${failure.reason[0]?.toUpperCase() ?? ""}${failure.reason.slice(1)}. Action: ${failure.action}.`;
}
