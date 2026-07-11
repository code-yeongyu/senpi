import {
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	sanitizeTerminalLabel,
	Text,
} from "@earendil-works/pi-tui";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionResult } from "./tool-execution-types.ts";

type ConvertedImage = NonNullable<Awaited<ReturnType<typeof convertToPng>>>;

type ConvertedImageEntry = {
	readonly sourceData: string;
	readonly sourceMimeType: string;
	readonly converted: ConvertedImage;
};

export type ToolExecutionImageOptions = {
	readonly showImages: boolean;
	readonly maxWidthCells: number;
	readonly showRendererFallback: boolean;
};

export class ToolExecutionImages extends Container {
	private readonly onAsyncChange: () => void;
	private result?: ToolExecutionResult;
	private resultGeneration = 0;
	private readonly convertedImages = new Map<number, ConvertedImageEntry>();
	private options: ToolExecutionImageOptions = {
		showImages: true,
		maxWidthCells: 60,
		showRendererFallback: false,
	};

	constructor(onAsyncChange: () => void) {
		super();
		this.onAsyncChange = onAsyncChange;
	}

	updateOptions(options: ToolExecutionImageOptions): void {
		const normalizedOptions = {
			...options,
			maxWidthCells: Math.max(1, Math.floor(options.maxWidthCells)),
		};
		if (
			this.options.showImages === normalizedOptions.showImages &&
			this.options.maxWidthCells === normalizedOptions.maxWidthCells &&
			this.options.showRendererFallback === normalizedOptions.showRendererFallback
		) {
			return;
		}
		this.options = normalizedOptions;
		this.rebuild();
	}

	updateResult(result: ToolExecutionResult): void {
		this.resultGeneration += 1;
		this.result = result;
		this.pruneConvertedImages();
		this.rebuild();
		this.maybeConvertImagesForKitty();
	}

	private imageBlocks() {
		return this.result?.content.filter((part) => part.type === "image") ?? [];
	}

	private pruneConvertedImages(): void {
		const imageBlocks = this.imageBlocks();
		for (const [index, converted] of this.convertedImages) {
			const image = imageBlocks[index];
			if (!image || image.data !== converted.sourceData || image.mimeType !== converted.sourceMimeType) {
				this.convertedImages.delete(index);
			}
		}
	}

	private maybeConvertImagesForKitty(): void {
		if (getCapabilities().images !== "kitty" || !this.result) return;

		const generation = this.resultGeneration;
		const imageBlocks = this.imageBlocks();
		for (let index = 0; index < imageBlocks.length; index += 1) {
			const image = imageBlocks[index];
			if (!image?.data || !image.mimeType || image.mimeType === "image/png") continue;
			const sourceData = image.data;
			const sourceMimeType = image.mimeType;
			const cached = this.convertedImages.get(index);
			if (cached?.sourceData === sourceData && cached.sourceMimeType === sourceMimeType) continue;

			convertToPng(sourceData, sourceMimeType).then((converted) => {
				if (!converted || this.resultGeneration !== generation) return;
				const currentImage = this.imageBlocks()[index];
				if (!currentImage || currentImage.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;

				this.convertedImages.set(index, { sourceData, sourceMimeType, converted });
				this.rebuild();
				this.onAsyncChange();
			});
		}
	}

	private rebuild(): void {
		this.clear();
		const capabilities = getCapabilities();
		if (!this.options.showImages || !capabilities.images) return;

		const imageBlocks = this.imageBlocks();
		for (let index = 0; index < imageBlocks.length; index += 1) {
			const image = imageBlocks[index];
			if (!image?.data || !image.mimeType) continue;
			const cached = this.convertedImages.get(index);
			const converted =
				cached?.sourceData === image.data && cached.sourceMimeType === image.mimeType
					? cached.converted
					: undefined;
			const imageData = converted?.data ?? image.data;
			const imageMimeType = converted?.mimeType ?? image.mimeType;
			if (capabilities.images === "kitty" && imageMimeType !== "image/png") {
				if (this.options.showRendererFallback) {
					this.addImageComponent(
						new Text(theme.fg("toolOutput", `[image: ${sanitizeTerminalLabel(imageMimeType)}]`), 0, 0),
					);
				}
				continue;
			}

			this.addImageComponent(
				new Image(
					imageData,
					imageMimeType,
					{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
					{ maxWidthCells: this.options.maxWidthCells },
				),
			);
		}
	}

	private addImageComponent(component: Component): void {
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}
