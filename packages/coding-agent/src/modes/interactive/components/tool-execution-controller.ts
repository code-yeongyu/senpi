import type { GrokToolRow } from "../grok/tool-row.ts";
import { AtomicToolRow, isAtomicToolPassthrough } from "./atomic-tool-row.ts";
import { createBoundedRenderSignature } from "./render-signature.ts";
import type { ToolExecutionImages } from "./tool-execution-images.ts";
import type { ToolExecutionRenderer } from "./tool-execution-renderer.ts";
import type { ToolExecutionIdentity, ToolExecutionRenderState, ToolOutputMode } from "./tool-execution-types.ts";

/** Visual shell chosen by interactive chrome; classic remains the default. */
export type ToolExecutionPresentation = "classic" | "grok";

type DisplayParts = {
	readonly renderer: ToolExecutionRenderer | undefined;
	readonly images: ToolExecutionImages | undefined;
	readonly grokRow: GrokToolRow | undefined;
	readonly renderContainer: (width: number) => string[];
};

export class ToolExecutionController {
	private readonly atomicRow: AtomicToolRow | undefined;
	private readonly identity: ToolExecutionIdentity;
	private readonly presentation: ToolExecutionPresentation;
	private outputMode: ToolOutputMode;
	private cachedLines?: string[];
	private cachedSignature?: string;
	private cachedWidth?: number;
	private lastDisplaySignature?: string;

	constructor(
		identity: ToolExecutionIdentity,
		initialState: ToolExecutionRenderState,
		outputMode: ToolOutputMode,
		presentation: ToolExecutionPresentation,
	) {
		this.identity = identity;
		this.outputMode = outputMode;
		this.presentation = presentation;
		if (!isAtomicToolPassthrough(identity)) this.atomicRow = new AtomicToolRow(identity, initialState);
	}

	get expanded(): boolean {
		return this.outputMode === "expanded";
	}

	get isAtomic(): boolean {
		return this.outputMode === "atomic" && this.atomicRow !== undefined;
	}

	setOutputMode(outputMode: ToolOutputMode): { changed: boolean; leftAtomic: boolean } {
		if (this.outputMode === outputMode) return { changed: false, leftAtomic: false };
		const leftAtomic = this.isAtomic;
		this.outputMode = outputMode;
		this.lastDisplaySignature = undefined;
		return { changed: true, leftAtomic };
	}

	atomicSpinnerPolicy(state: ToolExecutionRenderState): boolean | undefined {
		if (!this.isAtomic) return undefined;
		return (
			this.identity.trustedBuiltIn &&
			state.executionStarted &&
			state.isPartial &&
			state.result?.isError !== true &&
			(this.identity.toolName === "bash" || this.identity.toolName === "eval")
		);
	}

	updateDisplay(state: ToolExecutionRenderState, imageWidthCells: number, display: DisplayParts): void {
		if (this.isAtomic) {
			this.lastDisplaySignature = undefined;
			this.invalidateRenderCache();
			this.atomicRow!.update(state);
			display.renderer?.suspend();
			return;
		}
		const displaySignature = this.createRenderSignature(state, imageWidthCells);
		if (this.lastDisplaySignature === displaySignature) return;
		this.lastDisplaySignature = displaySignature;
		this.invalidateRenderCache();
		if (display.grokRow) {
			display.grokRow.update({
				toolName: this.identity.toolName,
				isPartial: state.isPartial,
				result: state.result,
			});
			return;
		}
		const renderer = display.renderer!;
		renderer.update(state);
		display.images!.updateOptions({
			showImages: state.showImages,
			maxWidthCells: imageWidthCells,
			showRendererFallback: renderer.hasResultRenderer,
		});
	}

	render(width: number, state: ToolExecutionRenderState, imageWidthCells: number, display: DisplayParts): string[] {
		const signature = this.isAtomic ? undefined : this.createRenderSignature(state, imageWidthCells);
		if (this.cachedLines && this.cachedWidth === width && (this.isAtomic || this.cachedSignature === signature)) {
			return [...this.cachedLines];
		}

		let lines: string[];
		if (this.isAtomic) {
			lines = this.atomicRow!.render(width);
		} else if (this.presentation === "grok") {
			lines = display.renderContainer(width);
		} else {
			const renderer = display.renderer!;
			const images = display.images!;
			if (renderer.hasRendererDefinition && renderer.renderShell === "self") {
				const contentLines = renderer.render(width);
				const imageLines = images.render(width);
				if (contentLines.length === 0 && imageLines.length === 0) return [];
				lines = contentLines.length > 0 ? ["", ...contentLines, ...imageLines] : imageLines;
			} else {
				lines = display.renderContainer(width);
			}
		}

		this.cachedWidth = width;
		this.cachedSignature = signature;
		this.cachedLines = [...lines];
		return lines;
	}

	invalidateDisplay(): void {
		this.invalidateRenderCache();
		this.lastDisplaySignature = undefined;
	}

	invalidateRenderCache(): void {
		this.cachedLines = undefined;
		this.cachedSignature = undefined;
		this.cachedWidth = undefined;
	}

	private createRenderSignature(state: ToolExecutionRenderState, imageWidthCells: number): string {
		return createBoundedRenderSignature({
			...state,
			imageWidthCells,
			outputMode: this.outputMode,
			toolCallId: this.identity.toolCallId,
			toolName: this.identity.toolName,
		});
	}
}
