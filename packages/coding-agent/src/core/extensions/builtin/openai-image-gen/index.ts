import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { resolveImageGenAuth } from "../imagegen/auth.ts";
import { imageGenRegistryOverride, setNativeBypass } from "../imagegen/state.ts";
import { externalizeNativeImages } from "./externalize.ts";
import {
	isOpenAiImageGenEnabled,
	type NativeImageGenTarget,
	nativeImageGenModelKey,
	supportsNativeOpenAiImageGeneration,
} from "./gate.ts";
import { applyImageGenerationTools, type ImageGenMode } from "./inject.ts";

export { isOpenAiImageGenEnabled, supportsNativeOpenAiImageGeneration } from "./gate.ts";
export { applyImageGenerationTools, NATIVE_IMAGE_GEN_TOOL_TYPE } from "./inject.ts";

/** Arbitration decision for one model. `source`/`reason` are diagnostics only. */
export interface ImageGenArbitrationState {
	kind: ImageGenMode;
	modelKey: string;
	source?: string;
	reason?: string;
}

export const OPENAI_IMAGE_GEN_SECTION = `
## Image Generation

Native image generation is available in this session.
Generate images with the built-in image_generation tool instead of a client-side tool.
`;

const UNKNOWN_MODEL_REASON = "No model is selected, so image generation availability is unknown.";

async function resolveState(model: NativeImageGenTarget, ctx: ExtensionContext): Promise<ImageGenArbitrationState> {
	const modelKey = nativeImageGenModelKey(model);
	if (model === undefined) {
		return { kind: "unavailable", modelKey, reason: UNKNOWN_MODEL_REASON };
	}
	if (supportsNativeOpenAiImageGeneration(model) && isOpenAiImageGenEnabled()) {
		return { kind: "native", modelKey, source: model.baseUrl };
	}

	const auth = await resolveImageGenAuth({ modelRegistry: imageGenRegistryOverride() ?? ctx.modelRegistry });
	if (auth.kind !== "none") {
		return { kind: "client", modelKey, source: `${auth.provenance}:${auth.providerId ?? auth.kind}` };
	}
	return { kind: "unavailable", modelKey, reason: auth.reason };
}

export default function openaiImageGenExtension(pi: ExtensionAPI): void {
	let state: ImageGenArbitrationState = { kind: "unavailable", modelKey: "", reason: UNKNOWN_MODEL_REASON };

	async function refresh(model: NativeImageGenTarget, ctx: ExtensionContext): Promise<void> {
		state = await resolveState(model, ctx);
		// Cross-builtin wiring: the client tool defers only while this builtin will
		// actually inject the server tool for this exact model. Both flip directions
		// run through here, so a switch back to a proxied endpoint re-arms the tool.
		setNativeBypass(state.kind === "native");
	}

	/**
	 * Payload hooks observe the effective request model, which can differ from the
	 * model the last lifecycle event cached (fallback routing, per-request model
	 * resolution). Refresh before mutating so a stale decision never reaches the wire.
	 */
	async function ensureFresh(model: NativeImageGenTarget, ctx: ExtensionContext): Promise<void> {
		if (nativeImageGenModelKey(model) !== state.modelKey) {
			await refresh(model, ctx);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx.model, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		await refresh(event.model, ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = event.model ?? ctx.model;
		await ensureFresh(model, ctx);
		return applyImageGenerationTools(event.payload, state.kind);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ensureFresh(ctx.model, ctx);
		if (state.kind !== "native") return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${OPENAI_IMAGE_GEN_SECTION}` };
	});

	// Runs for every assistant message regardless of arbitration state: whichever
	// path produced the bytes, they must never reach session history.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;
		const message = await externalizeNativeImages(event.message, ctx.cwd);
		return message === undefined ? undefined : { message };
	});

	pi.on("session_shutdown", async () => {
		setNativeBypass(false);
	});
}
