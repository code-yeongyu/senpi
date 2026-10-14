/** An explicit model selection has no usable credentials for its provider. */
export class ModelSwitchAuthError extends Error {
	constructor(provider: string, modelId: string) {
		super(`No API key for ${provider}/${modelId}`);
		this.name = "ModelSwitchAuthError";
	}
}
