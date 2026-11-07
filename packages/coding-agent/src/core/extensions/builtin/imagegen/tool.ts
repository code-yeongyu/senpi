import { existsSync } from "node:fs";
import { parseOpenAIImageOutputOptions, parseOpenAIImageSize } from "@earendil-works/pi-ai/compat";
import { defineTool, type ExtensionContext } from "../../types.ts";
import {
	type ImageGenAuthResolution,
	imageGenAvailability,
	imageGenCandidates,
	setupReason,
	unsupportedImageGateways,
} from "./auth.ts";
import { type ModelAttempt, requestImagesWithModelFallback } from "./model-request.ts";
import { DEFAULT_IMAGE_MODEL, failure, type GenerateImageDetails, Params, supportsComplexity } from "./params.ts";
import { displayPath, outputFormatOf, resolveTargets, withFormatExtension } from "./paths.ts";
import { loadMaskImage, loadReferenceImages } from "./reference-images.ts";
import { collectImages, writeImages } from "./saved-images.ts";
import { exhaustedProvidersMessage, requestImagesAcrossCandidates, skippedProvidersNote } from "./request.ts";
import { imageGenRegistryOverride, isNativeBypass, NATIVE_BYPASS_MESSAGE } from "./state.ts";

export type { GenerateImageDetails } from "./params.ts";

function sourceLabel(auth: ImageGenAuthResolution): string {
	if (auth.kind === "none") return "none";
	if (auth.provenance === "env") return "env:OPENAI_API_KEY";
	return `${auth.provenance}:${auth.providerId ?? auth.kind}`;
}

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export const generateImageTool = defineTool<typeof Params, GenerateImageDetails>({
	name: GENERATE_IMAGE_TOOL_NAME,
	label: "Generate Image",
	description:
		"Generate or edit an image with OpenAI gpt-image-2.6 (Sunburst by default, the most capable; Flare when speed matters more than quality; an endpoint without 2.6 falls back to 2.5) and save it as a png, jpeg, or webp file, optionally with a transparent background. Pass reference_image_paths to edit or reference existing images. Generate directly when the request is clear instead of asking for confirmation. Returns the saved file paths.",
	promptSnippet:
		"Generate or edit images from prompts and optional reference images, saving them as png/jpeg/webp files.",
	// Deferred: the schema costs ~1K prompt tokens on every request and the bundled imagegen skill
	// names the tool, so a by-name call activates it on first use instead of shipping it resident.
	exposure: "search",
	searchGroup: "imagegen",
	searchKeywords: [
		"generate image",
		"image generation",
		"edit image",
		"create a picture",
		"illustration",
		"mockup",
		"gpt-image",
		"transparent png",
	],
	parameters: Params,
	async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
		const size = params.size ?? "auto";
		const quality = params.quality ?? "auto";
		const requested = params.n ?? 1;
		const modelId = params.model ?? DEFAULT_IMAGE_MODEL;
		const background = params.background ?? "auto";
		const outputFormat = params.output_format ?? "png";
		const context = { model: modelId, size, quality, background, outputFormat, requested, source: "none" };

		const prompt = params.prompt.trim();
		if (prompt.length === 0) {
			return failure("Error: prompt must contain non-whitespace text.", "invalid_params", context);
		}
		if (isNativeBypass(ctx.sessionManager)) {
			return failure(NATIVE_BYPASS_MESSAGE, "provider_native_bypass", context);
		}
		if (params.complexity !== undefined && !supportsComplexity(modelId)) {
			return failure(
				`Error: complexity is supported only on GPT Image 2.6 models, not ${modelId}.`,
				"invalid_params",
				context,
			);
		}

		const modelRegistry = imageGenRegistryOverride() ?? ctx.modelRegistry;
		const candidates = imageGenCandidates({ modelRegistry });
		const firstCandidate = await candidates.next();
		if (firstCandidate.done) {
			// A configured source whose credential did not resolve (a failing key command) is not "not configured" (senpi#5707).
			const configured = await imageGenAvailability({ modelRegistry });
			if (configured.kind !== "none") {
				return failure(
					`Error: image generation is configured through ${configured.providerId ?? "OPENAI_API_KEY"}, but its credential could not be resolved (a key command failed or returned nothing, or the key is a placeholder). Fix that credential and retry.`,
					"credential_unavailable",
					context,
				);
			}
			const unsupported = await unsupportedImageGateways({ modelRegistry });
			const result = failure(setupReason(unsupported), "missing_config", context);
			if (unsupported.length === 0) return result;
			return { ...result, details: { ...result.details, unsupportedProviders: unsupported } };
		}
		let source = sourceLabel(firstCandidate.value);
		const parsedSize = parseOpenAIImageSize(size);
		if (!parsedSize.ok) {
			return failure(`Error: ${parsedSize.error}`, "invalid_params", { ...context, source });
		}
		const references = await loadReferenceImages(ctx.cwd, params.reference_image_paths);
		if (!references.ok) {
			return failure(references.error, "invalid_params", { ...context, source });
		}
		const mask = await loadMaskImage(ctx.cwd, params.mask_image_path, references.images.length);
		if (mask !== undefined && !mask.ok) {
			return failure(mask.error, "invalid_params", { ...context, source });
		}
		const outputOptions = parseOpenAIImageOutputOptions({
			background,
			outputFormat,
			outputCompression: params.output_compression,
			hasMask: mask !== undefined,
			imageCount: references.images.length,
		});
		if (!outputOptions.ok) {
			return failure(`Error: ${outputOptions.error}`, "invalid_params", { ...context, source });
		}
		const targets = resolveTargets(ctx.cwd, toolCallId, requested, params.output_path, outputFormat);
		if (!targets.ok) {
			return failure(targets.error, "invalid_params", { ...context, source });
		}
		for (const target of targets.paths) {
			if (existsSync(target)) {
				return failure(
					`Error: ${displayPath(ctx.cwd, target)} already exists. Choose another output_path.`,
					"invalid_params",
					{ ...context, source },
				);
			}
		}

		let lastAttempt: ModelAttempt | undefined;
		const outcome = await requestImagesAcrossCandidates(firstCandidate.value, candidates, async (auth) => {
			const attempt = await requestImagesWithModelFallback(
				auth,
				modelId,
				{ input: [{ type: "text", text: prompt }, ...references.images] },
				{
					...(signal === undefined ? {} : { signal }),
					size,
					quality,
					n: requested,
					...(params.background === undefined ? {} : { background }),
					outputFormat,
					...(params.output_compression === undefined ? {} : { outputCompression: params.output_compression }),
					...(params.moderation === undefined ? {} : { moderation: params.moderation }),
					...(mask === undefined ? {} : { mask: mask.image }),
				},
				params.complexity,
			);
			lastAttempt = attempt;
			return attempt.images;
		});
		if (outcome.kind === "exhausted") {
			return failure(exhaustedProvidersMessage(outcome.skipped), "provider_error", { ...context, source });
		}
		const { images } = outcome;
		source = sourceLabel(outcome.auth);
		const usedModel = lastAttempt?.model ?? modelId;
		const fallbackFrom = lastAttempt?.fallbackFrom;
		context.model = usedModel;
		if (images.stopReason !== "stop") {
			const message = images.errorMessage ?? `Image generation ${images.stopReason}.`;
			return failure(`Error: ${message}`, "provider_error", { ...context, source });
		}

		const generated = collectImages(images);
		if (generated.length === 0) {
			return failure("Error: the provider returned no images.", "provider_error", { ...context, source });
		}
		// A gateway may ignore output_format; name each file after the bytes it actually holds.
		const delivered = generated.map((image) => outputFormatOf(image.mimeType) ?? outputFormat);
		const savedFormat = delivered[0] ?? outputFormat;
		const paths = targets.paths.map((target, index) => {
			const format = delivered[index];
			return format === undefined || format === outputFormat ? target : withFormatExtension(target, format);
		});
		const renamedCollision = paths.find((target, index) => target !== targets.paths[index] && existsSync(target));
		if (renamedCollision !== undefined) {
			return failure(
				`Error: the provider returned ${savedFormat} instead of ${outputFormat} and ${displayPath(ctx.cwd, renamedCollision)} already exists. Choose another output_path.`,
				"write_failed",
				{ ...context, source },
			);
		}
		const writeError = await writeImages(paths, generated);
		if (writeError !== undefined) {
			return failure(writeError, "write_failed", { ...context, source });
		}

		const savedPaths = paths.slice(0, generated.length).map((target) => displayPath(ctx.cwd, target));
		const revisedPrompts = generated.flatMap((image) => (image.revisedPrompt ? [image.revisedPrompt] : []));
		const details: GenerateImageDetails = {
			paths: savedPaths,
			model: usedModel,
			...(fallbackFrom === undefined ? {} : { fallbackFrom }),
			source,
			size,
			quality,
			background,
			outputFormat: savedFormat,
			requested,
			generated: generated.length,
			revisedPrompts,
			...(images.background === undefined ? {} : { transparentBackground: images.background === "transparent" }),
		};
		const summary = [
			`Generated ${generated.length} image${generated.length === 1 ? "" : "s"}:`,
			...savedPaths.map((path) => `- ${path}`),
			...(savedFormat === outputFormat
				? []
				: [
						`Note: the provider returned ${savedFormat} instead of the requested ${outputFormat}; saved with the matching extension.`,
					]),
			...(fallbackFrom === undefined
				? []
				: [`Note: ${source} does not serve ${fallbackFrom} yet; generated with ${usedModel} instead.`]),
			...(images.background === undefined ? [] : [`Background: ${images.background}`]),
			...[skippedProvidersNote(outcome.skipped)].flatMap((note) => (note === undefined ? [] : [note])),
			...revisedPrompts.map((revised) => `Revised prompt: ${revised}`),
			"The saved file is the deliverable; refer to it by path instead of re-embedding image data.",
		].join("\n");
		return {
			content: [
				{ type: "text" as const, text: summary },
				...generated.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
			],
			details,
			...(images.usage === undefined ? {} : { usage: images.usage }),
		};
	},
});
