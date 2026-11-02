import type { ExtensionAPI } from "../../types.ts";
import { resolveVertexModelGardenAmbient } from "./auth.ts";
import { VERTEX_MODEL_GARDEN_MODELS } from "./models.ts";
import {
	defaultResolveVertexAccess,
	type ResolveVertexAccess,
	streamVertexModelGarden,
	VERTEX_MODEL_GARDEN_REGISTRATION_BASE_URL,
} from "./transport.ts";

export const VERTEX_MODEL_GARDEN_PROVIDER_ID = "vertex-garden";

export function registerVertexModelGarden(
	pi: ExtensionAPI,
	resolveAccess: ResolveVertexAccess = defaultResolveVertexAccess,
): void {
	pi.registerProvider(VERTEX_MODEL_GARDEN_PROVIDER_ID, {
		name: "Vertex AI Model Garden",
		api: "openai-completions",
		baseUrl: VERTEX_MODEL_GARDEN_REGISTRATION_BASE_URL,
		// Ambient like the builtin google-vertex ADC lane (senpi#2327): available
		// while the ADC chain is present, never an explicitly configured provider,
		// and never the automatic default over one the user configured.
		ambientAuth: {
			name: "Google Cloud credentials (ADC)",
			resolve: resolveVertexModelGardenAmbient,
		},
		models: VERTEX_MODEL_GARDEN_MODELS,
		streamSimple: (model, context, options) => streamVertexModelGarden(model, context, options, resolveAccess),
		fallbackEligible: () => false,
	});
}

export default function vertexModelGardenExtension(pi: ExtensionAPI): void {
	registerVertexModelGarden(pi);
}
