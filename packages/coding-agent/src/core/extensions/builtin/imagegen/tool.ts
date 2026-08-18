import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantImages, ImagesModel } from "@earendil-works/pi-ai/compat";
import { generateImages } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { defineTool, type ExtensionContext } from "../../types.ts";
import { type ImageGenAuthResolution, resolveImageGenAuth } from "./auth.ts";
import { displayPath, resolveTargets } from "./paths.ts";
import { imageGenRegistryOverride, isNativeBypass, NATIVE_BYPASS_MESSAGE } from "./state.ts";

const MODEL_ID = "gpt-image-2";

const Params = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			maxLength: 32_000,
			description: "Detailed description of the image to generate.",
		}),
		size: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("1024x1024"), Type.Literal("1024x1536"), Type.Literal("1536x1024")],
				{ default: "auto", description: "Output resolution. Defaults to auto." },
			),
		),
		quality: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
				default: "auto",
				description: "Rendering quality. Defaults to auto.",
			}),
		),
		n: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 10, default: 1, description: "How many images to generate." }),
		),
		output_path: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Where to write the image, relative to the working directory. Must end in .png. Defaults to generated-images/.",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface GenerateImageDetails {
	paths: string[];
	model: string;
	source: string;
	size: string;
	quality: string;
	requested: number;
	generated: number;
	revisedPrompts: string[];
	error?: string;
	reason?: "missing_config" | "provider_native_bypass" | "invalid_params" | "write_failed" | "provider_error";
}

/**
 * Only the registry surface the credential resolver needs. The session passes its
 * full ModelRegistry, which satisfies this structurally.
 */
function failure(
	message: string,
	reason: NonNullable<GenerateImageDetails["reason"]>,
	base: Pick<GenerateImageDetails, "size" | "quality" | "requested" | "source">,
) {
	const details: GenerateImageDetails = {
		...base,
		paths: [],
		model: MODEL_ID,
		generated: 0,
		revisedPrompts: [],
		error: message,
		reason,
	};
	return { content: [{ type: "text" as const, text: message }], details };
}

function sourceLabel(auth: ImageGenAuthResolution): string {
	if (auth.kind === "none") return "none";
	if (auth.provenance === "env") return "env:OPENAI_API_KEY";
	return `${auth.provenance}:${auth.providerId ?? auth.kind}`;
}

function synthesizeModel(auth: Extract<ImageGenAuthResolution, { kind: "native-openai" | "gateway" }>) {
	const model: ImagesModel<"openai-images"> = {
		id: MODEL_ID,
		name: "GPT Image 2",
		api: "openai-images",
		provider: auth.providerId ?? "openai",
		baseUrl: auth.baseUrl,
		input: ["text"],
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
		"Generate an image from a text prompt with gpt-image-2 and save it as a PNG file. Returns the saved file paths.",
	promptSnippet: "Generate images from text prompts and save them as PNG files.",
	parameters: Params,
	async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
		const size = params.size ?? "auto";
		const quality = params.quality ?? "auto";
		const requested = params.n ?? 1;
		const context = { size, quality, requested, source: "none" };

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
			synthesizeModel(auth),
			{ input: [{ type: "text", text: prompt }] },
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
			model: MODEL_ID,
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
