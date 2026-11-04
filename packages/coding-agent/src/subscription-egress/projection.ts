import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { classifySdkError } from "../core/extensions/builtin/anthropic-subscription/errors.ts";
import { assistantSchema } from "./content-schema.ts";
import { type ProviderCallOutput, providerEventSchema } from "./schema.ts";

type Failure = Pick<Extract<ProviderCallOutput, { type: "provider.call.error" }>, "code" | "retryable">;
const messages: Record<Failure["code"], string> = {
	auth: "Subscription authentication failed.",
	rate_limited: "Subscription accounts are rate limited.",
	unavailable: "Subscription provider unavailable.",
	aborted: "Operation aborted.",
	invalid_request: "Invalid subscription request.",
};

export function failure(error: string, aborted: boolean): Failure {
	if (aborted) return { code: "aborted", retryable: false };
	const classified = classifySdkError(error);
	switch (classified.kind) {
		case "auth_error":
		case "org_not_allowed":
			return { code: "auth", retryable: classified.retryable };
		case "rate_limit":
			return { code: "rate_limited", retryable: classified.retryable };
		default:
			return { code: "unavailable", retryable: classified.retryable };
	}
}

export function projectAssistant(message: AssistantMessage, code?: Failure["code"]) {
	// JSON conversion matches wire semantics (including omitted undefined tool arguments).
	// The schema strips provider-private fields; callers never receive a live partial reference.
	return assistantSchema.parse(
		JSON.parse(
			JSON.stringify({
				role: message.role,
				content: message.content,
				api: message.api,
				provider: message.provider,
				model: message.model,
				usage: message.usage,
				stopReason: code === "aborted" ? "aborted" : code ? "error" : message.stopReason,
				timestamp: message.timestamp,
				...(code ? { errorMessage: messages[code] } : {}),
			}),
		),
	);
}

export function projectEvent(event: Exclude<AssistantMessageEvent, { type: "done" | "error" }>) {
	const projected = { ...event, partial: projectAssistant(event.partial) };
	return providerEventSchema.parse(JSON.parse(JSON.stringify(projected)));
}
