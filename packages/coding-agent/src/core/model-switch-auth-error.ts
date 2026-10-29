/** An explicit model selection has no usable credentials for its provider. */
export class ModelSwitchAuthError extends Error {
	constructor(provider: string, modelId: string) {
		super(
			`${provider} is not connected, so ${provider}/${modelId} cannot be selected. Add an API key or sign in for ${provider}, then select the model again.`,
		);
		this.name = "ModelSwitchAuthError";
	}
}
