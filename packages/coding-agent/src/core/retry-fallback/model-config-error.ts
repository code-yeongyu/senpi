import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FallbackLogger } from "./log.ts";

const EXCERPT_LIMIT = 500;

export interface ModelConfigErrorEvent {
	type: "model_config_error";
	model: string;
	provider: string;
	errorExcerpt: string;
}

export interface ModelConfigErrorReporter {
	/** Emit the event and log warning once per model and session for a message already marked. */
	report(message: AssistantMessage, sessionId: string): void;
}

/**
 * A model configuration error is never retried or fallen back: another model would answer a request the caller did
 * not make (senpi#4282). The provider stream classified the raw body and redacted it (`sanitizeProviderErrorMessage`
 * in pi-ai), so only the typed cause is read here, never the redacted text.
 */
export function isModelConfigFailure(message: Pick<AssistantMessage, "errorCause">): boolean {
	return message.errorCause?.type === "model_config";
}

export function createModelConfigErrorReporter(
	logger: FallbackLogger,
	emit: (event: ModelConfigErrorEvent) => void,
): ModelConfigErrorReporter {
	const reported = new Set<string>();
	return {
		report(message, sessionId) {
			const model = `${message.provider}/${message.model}`;
			const key = `${sessionId}\u0000${model}`;
			if (reported.has(key)) return;
			reported.add(key);
			const errorMessage = message.errorMessage ?? "";
			logger.warn("model_config_error", { model, provider: message.provider, errorMessage });
			emit({
				type: "model_config_error",
				model,
				provider: message.provider,
				errorExcerpt: errorMessage.slice(0, EXCERPT_LIMIT),
			});
		},
	};
}
