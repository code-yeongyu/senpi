import type { ExtensionContext } from "@code-yeongyu/senpi";
import { convertToPng, formatDimensionNote, resizeImage } from "@code-yeongyu/senpi";

export interface EvalImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface EvalImageResizeResult {
	readonly image: EvalImageContent;
	readonly dimensionNote?: string;
}

export type EvalImageResizer = (
	image: EvalImageContent,
	model: ExtensionContext["model"],
) => Promise<EvalImageResizeResult>;

type WebpModel = { readonly provider: string; readonly api: string } | undefined;

export function webpExclusionForModel(model: WebpModel): true | undefined {
	if (model === undefined) return undefined;
	return model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
		? true
		: undefined;
}

export const resizeEvalImage: EvalImageResizer = async (image, model) => {
	const excludeWebP = webpExclusionForModel(model);
	const forceWebpConversion = excludeWebP === true && image.mimeType === "image/webp";
	const resized = await resizeImage(
		Buffer.from(image.data, "base64"),
		image.mimeType,
		forceWebpConversion ? { maxBytes: Buffer.byteLength(image.data, "utf8") } : undefined,
	);
	let output: EvalImageContent =
		resized === null ? image : { type: "image", data: resized.data, mimeType: resized.mimeType };
	if (excludeWebP === true && output.mimeType === "image/webp") {
		const converted = await convertToPng(output.data, output.mimeType);
		if (converted === null)
			throw new TypeError(`Unable to convert ${output.mimeType} display output for the active model`);
		output = { type: "image", data: converted.data, mimeType: converted.mimeType };
	}
	const dimensionNote = resized === null ? undefined : formatDimensionNote(resized);
	return { image: output, ...(dimensionNote === undefined ? {} : { dimensionNote }) };
};
