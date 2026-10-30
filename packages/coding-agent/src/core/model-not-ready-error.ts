/** Why a turn cannot start; the RPC `prompt` refusal carries it as `errorCode`. */
export type ModelNotReadyCode = "provider_credentials_missing" | "provider_credentials_expired" | "no_model_selected";

/** A turn cannot start: no model is selected, or its provider has no credentials. */
export class ModelNotReadyError extends Error {
	readonly code: ModelNotReadyCode;
	/** The selected model's provider; absent for `no_model_selected`. */
	readonly provider: string | undefined;

	constructor(message: string, code: ModelNotReadyCode, provider?: string) {
		super(message);
		this.name = "ModelNotReadyError";
		this.code = code;
		this.provider = provider;
	}
}
