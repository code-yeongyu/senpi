import { Type } from "typebox";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2.6-sunburst";
/**
 * The native Responses `image_generation` tool has no client-side retry, so it stays on the newest model
 * verified end to end through the ChatGPT subscription backend until 2.6 is proven there (senpi#5820).
 */
export const NATIVE_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const IMAGE_MODEL_NAMES = {
	"gpt-image-2.6-sunburst": "GPT Image 2.6 Sunburst",
	"gpt-image-2.6-flare": "GPT Image 2.6 Flare",
	"gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
	"gpt-image-2.5-flare": "GPT Image 2.5 Flare",
	"gpt-image-2": "GPT Image 2",
} as const;
export type ImageModelId = keyof typeof IMAGE_MODEL_NAMES;
/** Gateway allowlists lag OpenAI releases: a 2.6 id the endpoint does not serve retries once on its 2.5 counterpart. */
export const IMAGE_MODEL_FALLBACKS: Readonly<Partial<Record<ImageModelId, ImageModelId>>> = {
	"gpt-image-2.6-sunburst": "gpt-image-2.5-sunburst",
	"gpt-image-2.6-flare": "gpt-image-2.5-flare",
};
/** Only GPT Image 2.6 accepts the `complexity` request field. */
export function supportsComplexity(model: ImageModelId): boolean {
	return model === "gpt-image-2.6-sunburst" || model === "gpt-image-2.6-flare";
}

export const Params = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			maxLength: 32_000,
			description: "Detailed description of the desired image, including the end state for edits.",
		}),
		model: Type.Optional(
			Type.Union(
				[
					Type.Literal("gpt-image-2.6-sunburst"),
					Type.Literal("gpt-image-2.6-flare"),
					Type.Literal("gpt-image-2.5-sunburst"),
					Type.Literal("gpt-image-2.5-flare"),
					Type.Literal("gpt-image-2"),
				],
				{
					default: DEFAULT_IMAGE_MODEL,
					description:
						"gpt-image-2.6-sunburst (default) is the most capable: highest quality, dense text, and the most consistent details across repeated edits; gpt-image-2.6-flare is the fast model for iteration and layouts. An endpoint that does not serve a 2.6 model yet is retried once on its 2.5 counterpart. The 2.5 pair and gpt-image-2 are previous generations.",
				},
			),
		),
		size: Type.Optional(
			Type.String({
				default: "auto",
				description:
					"auto, 1024x1024, 1536x1024, 1024x1536, or any WIDTHxHEIGHT with both divisible by 16, aspect between 1:3 and 3:1, max 3840x2160 (e.g. 2048x2048, 2048x1152, 3840x2160)",
			}),
		),
		quality: Type.Optional(
			Type.Union(
				[
					Type.Literal("auto"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
					Type.Literal("max"),
				],
				{
					default: "auto",
					description:
						"Rendering quality. Defaults to auto. xhigh/max need gpt-image-2.5 or 2.6 and are slower and costlier.",
				},
			),
		),
		complexity: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
				description:
					"GPT Image 2.6 only: how much the model plans before rendering, at no extra cost. Omitted means high. low suits focused edits; medium/high help dense text and complex layouts but are slower and may change more.",
			}),
		),
		reference_image_paths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 5,
				description:
					"Local PNG/JPEG/WEBP images to edit or use as references (1-5 files, each at most 50 MB). Paths may be absolute or relative to the working directory.",
			}),
		),
		mask_image_path: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Inpainting mask (PNG with an alpha channel, same size as the first reference image): transparent areas are repainted. Requires reference_image_paths.",
			}),
		),
		background: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("transparent"), Type.Literal("opaque")], {
				default: "auto",
				description:
					"Output background. transparent needs output_format png or webp and keeps the alpha channel; auto lets the model decide.",
			}),
		),
		output_format: Type.Optional(
			Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], {
				default: "png",
				description:
					"File format. png (default) is lossless and supports transparency; jpeg is fastest; webp is small and supports transparency.",
			}),
		),
		output_compression: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 100,
				description: "Compression level 0-100 for jpeg or webp output only (100 = best quality).",
			}),
		),
		moderation: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("low")], {
				default: "auto",
				description: "Content filter strictness: auto (standard) or low (less restrictive).",
			}),
		),
		n: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 10,
				default: 1,
				description: "How many variants of this one prompt to generate; distinct assets need distinct calls.",
			}),
		),
		output_path: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Where to write the image, relative to the working directory. The extension must match output_format (.png, .jpg/.jpeg, .webp) or be omitted. Defaults to generated-images/.",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface GenerateImageDetails {
	paths: string[];
	/** The model that produced the images; differs from the request when `fallbackFrom` is set. */
	model: string;
	/** The requested 2.6 model the endpoint did not serve, when the 2.5 counterpart answered instead. */
	fallbackFrom?: string;
	source: string;
	size: string;
	quality: string;
	background: string;
	outputFormat: string;
	requested: number;
	generated: number;
	revisedPrompts: string[];
	/** Provider-reported transparency of the saved images, when it reports one. */
	transparentBackground?: boolean;
	error?: string;
	/** Logged-in providers passed over because their API serves no OpenAI Images endpoint (senpi#5674). */
	unsupportedProviders?: string[];
	reason?:
		| "missing_config"
		| "credential_unavailable"
		| "provider_native_bypass"
		| "invalid_params"
		| "write_failed"
		| "provider_error";
}

export function failure(
	message: string,
	reason: NonNullable<GenerateImageDetails["reason"]>,
	base: Pick<
		GenerateImageDetails,
		"model" | "size" | "quality" | "background" | "outputFormat" | "requested" | "source"
	>,
) {
	const details: GenerateImageDetails = {
		...base,
		paths: [],
		generated: 0,
		revisedPrompts: [],
		error: message,
		reason,
	};
	return { content: [{ type: "text" as const, text: message }], details };
}
