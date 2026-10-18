import type { AuthContext, AuthResult } from "@earendil-works/pi-ai";

/** The ADC file `gcloud auth application-default login` writes, same as the builtin google-vertex provider. */
export const VERTEX_MODEL_GARDEN_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";
export const VERTEX_MODEL_GARDEN_ADC_SOURCE = "gcloud application default credentials";

/**
 * Availability through the shared Google Application Default Credentials chain.
 * This is deliberately ambient (senpi#2327): the credentials exist for other
 * gcloud tooling too, so the lane is selectable but never outranks a provider the
 * user configured, and it reports nothing while the chain is absent — the failure
 * belongs at selection time, not at the first request.
 */
export async function resolveVertexModelGardenAmbient(input: {
	ctx: AuthContext;
	signal: AbortSignal;
}): Promise<AuthResult | undefined> {
	input.signal.throwIfAborted();
	const path = (await input.ctx.env("GOOGLE_APPLICATION_CREDENTIALS")) ?? VERTEX_MODEL_GARDEN_ADC_PATH;
	input.signal.throwIfAborted();
	if (!(await input.ctx.fileExists(path))) return undefined;
	return { auth: {}, source: VERTEX_MODEL_GARDEN_ADC_SOURCE, ambient: true };
}
