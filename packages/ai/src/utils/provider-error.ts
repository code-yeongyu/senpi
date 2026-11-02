import type { AssistantMessage } from "../types.ts";
import { redactCredentialShapes, redactSecrets } from "./secret-redaction.ts";

export { redactCredentialShapes, redactSecrets };

// A route that does not serve a configured model id: the OpenAI-compatible `model_not_found` code and OpenAI's
// "The model `<id>` does not exist" prose, a gateway's "unknown provider for model", Anthropic's not_found_error whose
// message names the model ("model: <id>"; any other not_found_error is not one), and Google's "models/<id> is not found".
// Every quantifier is bounded, so a long run never makes a match attempt expensive.
const MODEL_CONFIG_ERROR =
	/\bmodel_not_found\b|\bunknown provider for model\b|\bthe model\s{1,8}[`'"]?[\w.:/-]{1,256}[`'"]?\s{1,8}does not exist\b|\bnot_found_error\b[^}]{0,120}?\bmodel:\s{0,8}[\w.:/-]|\bmodels\/[\w.:-]{1,256} is not found\b/i;

/** True when provider text says the route does not serve the configured model id (senpi#4282). */
export function isModelConfigError(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && MODEL_CONFIG_ERROR.test(errorMessage);
}

/**
 * The single point where a provider error body enters a message: classify a model configuration error on the RAW
 * text first (carried as `errorCause`), then keep only the redacted text for every provider error. Idempotent;
 * called for every message a provider stream publishes, so no partial, event or final result carries a raw body.
 */
export function sanitizeProviderErrorMessage(message: AssistantMessage): void {
	const raw = message.errorMessage;
	if (raw === undefined || raw.length === 0) return;
	if (message.stopReason === "error" && message.errorCause?.type !== "model_config" && isModelConfigError(raw)) {
		message.errorCause = { type: "model_config", model: `${message.provider}/${message.model}` };
	}
	const redacted = redactSecrets(raw);
	if (redacted !== raw) message.errorMessage = redacted;
}
