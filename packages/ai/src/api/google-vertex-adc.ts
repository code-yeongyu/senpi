import { GoogleAuth } from "google-auth-library";
import type { ProviderEnv } from "../types.ts";
import { buildGoogleAuthOptions, resolveVertexProjectFromEnv } from "./google-vertex-env.ts";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface VertexAdcAccess {
	accessToken: string;
	/** Project whose Vertex endpoints the request targets. */
	project: string;
	/** Project billed for quota (`x-goog-user-project`); the ADC quota project when set. */
	quotaProject: string;
}

const authByKey = new Map<string, GoogleAuth>();

function getGoogleAuth(env?: ProviderEnv): GoogleAuth {
	const authOptions = buildGoogleAuthOptions(env);
	const key = authOptions?.keyFilename ?? "";
	let auth = authByKey.get(key);
	if (!auth) {
		// One GoogleAuth per credential source so the library's token cache and refresh are reused.
		auth = new GoogleAuth({ ...authOptions, scopes: [CLOUD_PLATFORM_SCOPE] });
		authByKey.set(key, auth);
	}
	return auth;
}

/**
 * Resolves an access token plus target and quota projects from Application
 * Default Credentials, the same credential chain `@google/genai` uses for the
 * google-vertex provider. Project precedence: explicit option, then
 * GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT, then the ADC quota project, then the
 * project google-auth-library discovers (gcloud config, metadata server).
 */
export async function getVertexAdcAccess(options?: { project?: string; env?: ProviderEnv }): Promise<VertexAdcAccess> {
	const auth = getGoogleAuth(options?.env);
	const client = await auth.getClient();
	const { token } = await client.getAccessToken();
	if (!token) throw new Error("Google Application Default Credentials returned no access token.");
	const adcQuotaProject = client.quotaProjectId || undefined;
	const project =
		resolveVertexProjectFromEnv(options) ??
		adcQuotaProject ??
		((await auth.getProjectId().catch(() => null)) || undefined);
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or a quota project in Application Default Credentials.",
		);
	}
	return { accessToken: token, project, quotaProject: adcQuotaProject ?? project };
}
