import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { ApiKeyCredential, AuthContext } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";

// #2327: a shared cloud credential chain (AWS profile/keys/roles, Google ADC) makes a
// provider available without the user configuring it; resolution must say so.
function authContext(env: Record<string, string>, files: readonly string[] = []): AuthContext {
	return { env: async (name) => env[name], fileExists: async (path) => files.includes(path) };
}

async function resolveBedrock(env: Record<string, string>, credential?: ApiKeyCredential) {
	return amazonBedrockProvider().auth.apiKey?.resolve({
		ctx: authContext(env),
		credential,
		signal: new AbortController().signal,
	});
}

describe("ambient cloud credentials", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("#given AWS credential-chain env #when bedrock resolves #then the resolution is ambient", async () => {
		const keys = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" };
		expect(await resolveBedrock(keys)).toMatchObject({ source: "AWS access keys", ambient: true });
		expect(await resolveBedrock({ AWS_PROFILE: "work" })).toMatchObject({ source: "AWS_PROFILE", ambient: true });
		expect(await resolveBedrock({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" })).toMatchObject({
			ambient: true,
		});
		expect(await resolveBedrock({ AWS_WEB_IDENTITY_TOKEN_FILE: "/token" })).toMatchObject({ ambient: true });
	});

	it("#given a bedrock bearer token or a stored bedrock choice #when bedrock resolves #then it is not ambient", async () => {
		const bearer = await resolveBedrock({ AWS_BEARER_TOKEN_BEDROCK: "bedrock-token" });
		const storedKey = await resolveBedrock({}, { type: "api_key", key: "stored" });
		const storedProfile = await resolveBedrock({}, { type: "api_key", env: { AWS_PROFILE: "chosen" } });
		for (const resolution of [bearer, storedKey, storedProfile]) {
			expect(resolution).toBeDefined();
			expect(resolution?.ambient).toBeUndefined();
		}
	});

	it("#given gcloud ADC #when vertex resolves #then ADC is ambient and an API key is not", async () => {
		const adc = {
			GOOGLE_APPLICATION_CREDENTIALS: "/adc.json",
			GOOGLE_CLOUD_PROJECT: "p",
			GOOGLE_CLOUD_LOCATION: "l",
		};
		const resolve = (env: Record<string, string>) =>
			googleVertexProvider().auth.apiKey?.resolve({
				ctx: authContext(env, ["/adc.json"]),
				signal: new AbortController().signal,
			});
		expect(await resolve(adc)).toMatchObject({ ambient: true });
		expect((await resolve({ GOOGLE_CLOUD_API_KEY: "key" }))?.ambient).toBeUndefined();
	});

	it("#given ambient-only bedrock #when Models.checkAuth runs #then the check carries ambient", async () => {
		const models = createModels({
			credentials: new InMemoryCredentialStore(),
			authContext: authContext({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" }),
		});
		models.setProvider(amazonBedrockProvider());
		expect(await models.checkAuth("amazon-bedrock")).toEqual({
			source: "AWS access keys",
			type: "api_key",
			ambient: true,
		});
	});
});
