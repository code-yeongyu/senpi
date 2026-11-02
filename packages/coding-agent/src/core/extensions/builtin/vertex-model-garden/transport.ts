import {
	type Api,
	type AssistantMessageEventStream,
	getApiProvider,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getVertexAdcAccess, type VertexAdcAccess } from "@earendil-works/pi-ai/api/google-vertex-adc.lazy";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

export const VERTEX_MODEL_GARDEN_LOCATION = "global";

/**
 * The registration baseUrl. It only satisfies registration: while a model still carries it, the request URL is
 * built per call from the ADC-resolved project. Any other value is the user's models.json baseUrl (senpi#4765).
 */
export const VERTEX_MODEL_GARDEN_REGISTRATION_BASE_URL = "https://aiplatform.googleapis.com/v1";

export type ResolveVertexAccess = (options?: SimpleStreamOptions) => Promise<VertexAdcAccess>;

/**
 * The project comes from its own environment (`options.env`, then the ADC quota
 * project, then `getProjectId()`), never from the API-key slot: a stored secret
 * must not end up in the request URL, and the project may legitimately come from
 * ADC alone.
 */
export const defaultResolveVertexAccess: ResolveVertexAccess = (options) => getVertexAdcAccess({ env: options?.env });

export function vertexHost(location: string): string {
	return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

function buildVertexOpenApiBaseUrl(project: string, location: string = VERTEX_MODEL_GARDEN_LOCATION): string {
	return `https://${vertexHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}/endpoints/openapi`;
}

function requireApi(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) throw new Error(`API provider ${api} is not registered`);
	return provider;
}

export function streamVertexModelGarden(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	resolveAccess: ResolveVertexAccess = defaultResolveVertexAccess,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		const access = await resolveAccess(options);
		const baseUrl =
			model.baseUrl === VERTEX_MODEL_GARDEN_REGISTRATION_BASE_URL
				? buildVertexOpenApiBaseUrl(access.project)
				: model.baseUrl;
		const target = { ...model, baseUrl };
		return requireApi("openai-completions").streamSimple(target, context, {
			...options,
			apiKey: access.accessToken,
			headers: { ...options?.headers, "x-goog-user-project": access.quotaProject },
		});
	});
}
