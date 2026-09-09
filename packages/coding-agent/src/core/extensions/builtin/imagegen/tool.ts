import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantImages, ImagesModel } from "@earendil-works/pi-ai/compat";
import { generateImages, parseOpenAIImageSize } from "@earendil-works/pi-ai/compat";
import { defineTool, type ExtensionContext } from "../../types.ts";
import { type ImageGenAuthResolution, resolveImageGenAuth } from "./auth.ts";
import { DEFAULT_IMAGE_MODEL, failure, type GenerateImageDetails, IMAGE_MODEL_NAMES, Params } from "./params.ts";
import { displayPath, resolveTargets } from "./paths.ts";
import { loadReferenceImages } from "./reference-images.ts";
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
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return model;
}

interface GeneratedImage {
	data: string;
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
		collected.push({ data: block.data, ...(pendingText === undefined ? {} : { revisedPrompt: pendingText }) });
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
		"Generate or edit an image with OpenAI gpt-image-2.5 (Sunburst by default; Flare for speed) and save it as a PNG file. Pass reference_image_paths to edit or reference existing images. Returns the saved file paths.",
	promptSnippet: "Generate or edit images from prompts and optional reference images, saving them as PNG files.",
	parameters: Params,
	async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
		const size = params.size ?? "auto";
		const quality = params.quality ?? "auto";
		const requested = params.n ?? 1;
		const modelId = params.model ?? DEFAULT_IMAGE_MODEL;
		const context = { model: modelId, size, quality, requested, source: "none" };

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
		const targets = resolveTargets(ctx.cwd, toolCallId, requested, params.output_path);
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
		const writeError = await writeImages(targets.paths, generated);
		if (writeError !== undefined) {
			return failure(writeError, "write_failed", { ...context, source });
		}

		const savedPaths = targets.paths.slice(0, generated.length).map((target) => displayPath(ctx.cwd, target));
		const revisedPrompts = generated.flatMap((image) => (image.revisedPrompt ? [image.revisedPrompt] : []));
		const details: GenerateImageDetails = {
			paths: savedPaths,
			model: modelId,
			source,
			size,
			quality,
			requested,
			generated: generated.length,
			revisedPrompts,
		};
		const summary = [
			`Generated ${generated.length} image${generated.length === 1 ? "" : "s"}:`,
			...savedPaths.map((path) => `- ${path}`),
			...revisedPrompts.map((revised) => `Revised prompt: ${revised}`),
		].join("\n");
		return {
			content: [
				{ type: "text" as const, text: summary },
				...generated.map((image) => ({ type: "image" as const, data: image.data, mimeType: "image/png" })),
			],
			details,
			...(images.usage === undefined ? {} : { usage: images.usage }),
		};
	},
});
