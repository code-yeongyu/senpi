import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantImages, ImagesModel } from "@earendil-works/pi-ai/compat";
import {
	generateImages,
	getImageModel,
	parseOpenAIImageOutputOptions,
	parseOpenAIImageSize,
} from "@earendil-works/pi-ai/compat";
import { defineTool, type ExtensionContext } from "../../types.ts";
import { type ImageGenAuthResolution, resolveImageGenAuth } from "./auth.ts";
import { DEFAULT_IMAGE_MODEL, failure, type GenerateImageDetails, IMAGE_MODEL_NAMES, Params } from "./params.ts";
import { displayPath, outputFormatOf, resolveTargets, withFormatExtension } from "./paths.ts";
import { loadMaskImage, loadReferenceImages } from "./reference-images.ts";
import { imageGenRegistryOverride, isNativeBypass, NATIVE_BYPASS_MESSAGE } from "./state.ts";

export type { GenerateImageDetails } from "./params.ts";

function sourceLabel(auth: ImageGenAuthResolution): string {
	if (auth.kind === "none") return "none";
	if (auth.provenance === "env") return "env:OPENAI_API_KEY";
	return `${auth.provenance}:${auth.providerId ?? auth.kind}`;
}

function synthesizeModel(
	auth: Extract<ImageGenAuthResolution, { kind: "native-openai" | "gateway" }>,
	id: keyof typeof IMAGE_MODEL_NAMES,
) {
	const model: ImagesModel<"openai-images"> = {
		id,
		name: IMAGE_MODEL_NAMES[id],
		api: "openai-images",
		provider: auth.providerId ?? "openai",
		baseUrl: auth.baseUrl,
		input: ["text", "image"],
		output: ["image"],
		cost: getImageModel("openai", id).cost,
	};
	return model;
}

interface GeneratedImage {
	data: string;
	mimeType: string;
	revisedPrompt?: string;
}

function collectImages(images: AssistantImages): GeneratedImage[] {
	const collected: GeneratedImage[] = [];
	let pendingText: string | undefined;
	for (const block of images.output) {
		if (block.type === "text") {
			const text = block.text.trim();
			pendingText = text.length > 0 ? text : undefined;
			continue;
		}
		collected.push({
			data: block.data,
			mimeType: block.mimeType,
			...(pendingText === undefined ? {} : { revisedPrompt: pendingText }),
		});
		pendingText = undefined;
	}
	return collected;
}

async function writeImages(paths: string[], images: GeneratedImage[]): Promise<string | undefined> {
	const written: string[] = [];
	for (const [index, image] of images.entries()) {
		const target = paths[index];
		if (target === undefined) break;
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, Buffer.from(image.data, "base64"), { flag: "wx" });
			written.push(target);
		} catch (error) {
			for (const path of written) await rm(path, { force: true }).catch(() => undefined);
			const reason = error instanceof Error ? error.message : String(error);
			return `Error: failed to write generated image to ${target}: ${reason}`;
		}
	}
	return undefined;
}

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export const generateImageTool = defineTool<typeof Params, GenerateImageDetails>({
	name: GENERATE_IMAGE_TOOL_NAME,
	label: "Generate Image",
	description:
		"Generate or edit an image with OpenAI gpt-image-2.5 (Sunburst by default, the most capable; Flare when speed matters more than quality) and save it as a png, jpeg, or webp file, optionally with a transparent background. Pass reference_image_paths to edit or reference existing images. Generate directly when the request is clear instead of asking for confirmation. Returns the saved file paths.",
	promptSnippet:
		"Generate or edit images from prompts and optional reference images, saving them as png/jpeg/webp files.",
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
		if (isNativeBypass()) {
			return failure(NATIVE_BYPASS_MESSAGE, "provider_native_bypass", context);
		}

		const auth = await resolveImageGenAuth({ modelRegistry: imageGenRegistryOverride() ?? ctx.modelRegistry });
		if (auth.kind === "none") {
			return failure(auth.reason, "missing_config", context);
		}
		const source = sourceLabel(auth);
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

		const images = await generateImages(
			synthesizeModel(auth, modelId),
			{ input: [{ type: "text", text: prompt }, ...references.images] },
			{
				...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
				...(auth.headers === undefined ? {} : { headers: auth.headers }),
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
		);
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
			model: modelId,
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
			...(images.background === undefined ? [] : [`Background: ${images.background}`]),
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
