import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { Api, ImagesApi, ImagesModel, Model, ProviderEnv } from "../types.ts";

const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

type CloudflareAuthKind = "workers-ai" | "ai-gateway";

async function resolveValue(input: {
	name: string;
	ctx: AuthContext;
	credential: ApiKeyCredential | undefined;
}): Promise<string | undefined> {
	if (input.credential) {
		if (input.name === CLOUDFLARE_API_KEY) return input.credential.key;
		return input.credential.metadata?.[input.name];
	}
	return input.ctx.env(input.name);
}

function resolveCloudflareBaseUrl(
	model: Model<Api> | ImagesModel<ImagesApi>,
	accountId: string,
	gatewayId: string | undefined,
): string {
	return model.baseUrl
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, accountId)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, gatewayId ?? "");
}

async function resolveCloudflareEnv(input: {
	kind: CloudflareAuthKind;
	model: Model<Api> | ImagesModel<ImagesApi>;
	ctx: AuthContext;
	credential: ApiKeyCredential | undefined;
}): Promise<{ apiKey: string; env: ProviderEnv; baseUrl: string; source: string } | undefined> {
	const apiKey = await resolveValue({ name: CLOUDFLARE_API_KEY, ctx: input.ctx, credential: input.credential });
	const accountId = await resolveValue({ name: CLOUDFLARE_ACCOUNT_ID, ctx: input.ctx, credential: input.credential });
	const gatewayId =
		input.kind === "ai-gateway"
			? await resolveValue({ name: CLOUDFLARE_GATEWAY_ID, ctx: input.ctx, credential: input.credential })
			: undefined;

	if (!apiKey || !accountId || (input.kind === "ai-gateway" && !gatewayId)) return undefined;

	return {
		apiKey,
		env: {
			CLOUDFLARE_ACCOUNT_ID: accountId,
			...(gatewayId ? { CLOUDFLARE_GATEWAY_ID: gatewayId } : {}),
		},
		baseUrl: resolveCloudflareBaseUrl(input.model, accountId, gatewayId),
		source: input.credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			return { type: "api-key", key, metadata: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		resolve: async ({ model, ctx, credential }) => {
			const resolved = await resolveCloudflareEnv({ kind: "workers-ai", model, ctx, credential });
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl },
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}

export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			const gatewayId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			return {
				type: "api-key",
				key,
				metadata: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
			};
		},
		resolve: async ({ model, ctx, credential }) => {
			const resolved = await resolveCloudflareEnv({ kind: "ai-gateway", model, ctx, credential });
			if (!resolved) return undefined;
			return {
				auth: {
					headers: {
						"cf-aig-authorization": `Bearer ${resolved.apiKey}`,
						Authorization: null,
						"x-api-key": null,
					},
					baseUrl: resolved.baseUrl,
				},
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}
