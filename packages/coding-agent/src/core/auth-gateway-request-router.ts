import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthBrokerRemoteStore } from "./auth-broker-remote-store.ts";
import { createAnthropicMessagesGatewayAdapter } from "./auth-gateway-anthropic-messages.ts";
import { bareModel, modelForRequest, qualifyModel } from "./auth-gateway-model-select.ts";
import type { AuthGatewayAuthorizedModel } from "./auth-gateway-observability.ts";
import { createAuthGatewayObservabilityHandler } from "./auth-gateway-observability.ts";
import { createOpenAIChatGatewayAdapter } from "./auth-gateway-openai-chat.ts";
import type { AuthGatewayAdapterResponse } from "./auth-gateway-protocol-adapter.ts";
import {
	type AuthGatewayProviderRuntimeOptions,
	createAuthGatewayProviderRuntime,
} from "./auth-gateway-provider-runtime.ts";
import {
	type AuthGatewayAdapterResult,
	createAuthGatewayResponsesPiAdapter,
} from "./auth-gateway-responses-pi-adapter.ts";
import type { AuthGatewayTransportRequest, AuthGatewayTransportResponse } from "./auth-gateway-transport-types.ts";

export type AuthGatewayRequestRouterOptions = {
	readonly broker: AuthBrokerRemoteStore;
	readonly models: readonly AuthGatewayAuthorizedModel[];
	readonly resolveModel?: AuthGatewayProviderRuntimeOptions["resolveModel"];
	readonly resolveRequest?: AuthGatewayProviderRuntimeOptions["resolveRequest"];
	readonly streamSimple?: AuthGatewayProviderRuntimeOptions["streamSimple"];
};

export type AuthGatewayRequestRouter = {
	readonly handle: (request: AuthGatewayTransportRequest) => Promise<AuthGatewayTransportResponse>;
	close(): void;
};

export function createAuthGatewayRequestRouter(options: AuthGatewayRequestRouterOptions): AuthGatewayRequestRouter {
	const configuredResolver = options.resolveModel ?? defaultModelResolver;
	const runtime = createAuthGatewayProviderRuntime({
		broker: options.broker,
		resolveModel: (provider, modelId) =>
			isAuthorized(options.models, provider, modelId) ? configuredResolver(provider, modelId) : undefined,
		resolveRequest: options.resolveRequest,
		streamSimple: options.streamSimple,
	});
	const observability = createAuthGatewayObservabilityHandler({
		broker: options.broker,
		models: options.models,
	});
	const responsesPi = createAuthGatewayResponsesPiAdapter({ runtime });
	return {
		close: () => runtime.close(),
		handle: async (request) => {
			if (
				request.pathname === "/v1/models" ||
				request.pathname === "/v1/usage" ||
				request.pathname === "/v1/credentials/check"
			) {
				return observability(request);
			}
			const modelField = request.pathname === "/v1/pi/stream" ? "modelId" : "model";
			const authorizedModel = modelForRequest(options.models, request.body, modelField);
			if (authorizedModel === undefined) {
				return { body: { error: "unknown or unauthorized model" }, statusCode: 404 };
			}
			if (request.pathname === "/v1/chat/completions") {
				return transportResponse(
					await createOpenAIChatGatewayAdapter({
						provider: authorizedModel.provider,
						runtime,
					}).handle({
						// Chat adapter uses body.model as bare runtime modelId (provider is separate).
						body: bareModel(request.body, "model", authorizedModel),
						headers: request.headers,
						signal: request.signal,
					}),
				);
			}
			if (request.pathname === "/v1/messages") {
				return transportResponse(
					await createAnthropicMessagesGatewayAdapter({
						provider: authorizedModel.provider,
						runtime,
					}).handle({
						// Messages adapter uses body.model as bare runtime modelId (provider is separate).
						body: bareModel(request.body, "model", authorizedModel),
						headers: request.headers,
						signal: request.signal,
					}),
				);
			}
			if (request.pathname === "/v1/responses") {
				return transportResponse(
					await responsesPi.responses({
						body: qualifyModel(request.body, "model", authorizedModel),
						signal: request.signal,
					}),
				);
			}
			if (request.pathname === "/v1/pi/stream") {
				return transportResponse(
					await responsesPi.pi({
						body: qualifyModel(request.body, "modelId", authorizedModel),
						signal: request.signal,
					}),
				);
			}
			return { body: { error: "route adapter unavailable" }, statusCode: 501 };
		},
	};
}

function defaultModelResolver(provider: string, modelId: string): Model<Api> | undefined {
	const builtinProvider = getBuiltinProviders().find((candidate) => candidate === provider);
	if (builtinProvider === undefined) return undefined;
	return getBuiltinModels(builtinProvider).find((model) => model.id === modelId);
}

function isAuthorized(models: readonly AuthGatewayAuthorizedModel[], provider: string, modelId: string): boolean {
	return models.some((model) => model.provider === provider && model.modelId === modelId);
}

function transportResponse(
	result: AuthGatewayAdapterResponse | AuthGatewayAdapterResult,
): AuthGatewayTransportResponse {
	return result.kind === "json"
		? { body: result.body, statusCode: result.statusCode }
		: result.kind === "sse"
			? { frames: result.frames, statusCode: 200 }
			: { frames: dataFrames(result.frames), statusCode: 200 };
}

async function* dataFrames(frames: AsyncIterable<unknown>) {
	for await (const data of frames) yield { data };
}
