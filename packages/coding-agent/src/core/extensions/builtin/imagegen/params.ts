import { Type } from "typebox";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const IMAGE_MODEL_NAMES = {
	"gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
	"gpt-image-2.5-flare": "GPT Image 2.5 Flare",
	"gpt-image-2": "GPT Image 2",
} as const;

export const Params = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			maxLength: 32_000,
			description: "Detailed description of the desired image, including the end state for edits.",
		}),
		model: Type.Optional(
			Type.Union(
				[Type.Literal("gpt-image-2.5-sunburst"), Type.Literal("gpt-image-2.5-flare"), Type.Literal("gpt-image-2")],
				{
					default: DEFAULT_IMAGE_MODEL,
					description:
						"Sunburst (default) is the most capable: highest quality, precise edits, reference fidelity, best for final assets; Flare is the small model optimized for speed, with quality comparable to gpt-image-2; gpt-image-2 is the previous generation.",
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
						"Rendering quality. Defaults to auto. xhigh/max are gpt-image-2.5 only, slower and costlier.",
				},
			),
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
	model: string;
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
	reason?: "missing_config" | "provider_native_bypass" | "invalid_params" | "write_failed" | "provider_error";
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
