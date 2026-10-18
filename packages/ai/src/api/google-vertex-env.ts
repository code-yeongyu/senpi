import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export function resolveVertexProjectFromEnv(options?: { project?: string; env?: ProviderEnv }): string | undefined {
	return (
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env)
	);
}

export function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return keyFilename ? { keyFilename } : undefined;
}
