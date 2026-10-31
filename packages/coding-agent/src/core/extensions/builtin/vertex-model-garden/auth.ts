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
 *
 * The target project is resolved here so it rides the ambient auth result into
 * the request env: process env first, then the sibling google-vertex profile,
 * which shares this ADC chain and already names the project the user entered at
 * its login. With neither source the lane stays available and the request-time
 * ADC fallbacks (quota project, discovered project) decide, so a missing project
 * remains a first-request failure with the actionable error, not a hidden lane.
 */
export async function resolveVertexModelGardenAmbient(input: {
	ctx: AuthContext;
	signal: AbortSignal;
	/** Read-only env of another provider's stored credential; routing metadata only, never keys. */
	storedProviderEnv?(providerId: string): Promise<Record<string, string> | undefined>;
}): Promise<AuthResult | undefined> {
	input.signal.throwIfAborted();
	const path = (await input.ctx.env("GOOGLE_APPLICATION_CREDENTIALS")) ?? VERTEX_MODEL_GARDEN_ADC_PATH;
	input.signal.throwIfAborted();
	if (!(await input.ctx.fileExists(path))) return undefined;
	input.signal.throwIfAborted();
	const project =
		(await input.ctx.env("GOOGLE_CLOUD_PROJECT")) ??
		(await input.ctx.env("GCLOUD_PROJECT")) ??
		(await input.storedProviderEnv?.("google-vertex"))?.GOOGLE_CLOUD_PROJECT;
	return {
		auth: {},
		...(project ? { env: { GOOGLE_CLOUD_PROJECT: project } } : {}),
		source: VERTEX_MODEL_GARDEN_ADC_SOURCE,
		ambient: true,
	};
}
