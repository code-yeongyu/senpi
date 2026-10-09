import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { isModelOnlyText } from "../../../core/tools/model-only-text.ts";
import { GrokToolRow } from "../grok/tool-row.ts";
import { createBoundedRenderSignature } from "./render-signature.ts";
import { ToolExecutionAnimation, toolCardSpins, toolCardStrikes } from "./tool-execution-animation.ts";
import { serializedToolResultBytes, ToolExecutionRenderCache } from "./tool-execution-cache.ts";
import { collapseFallbackResult } from "./tool-execution-fallback-preview.ts";
import { ToolExecutionImages } from "./tool-execution-images.ts";
import { ToolExecutionRenderer } from "./tool-execution-renderer.ts";
import type {
	ToolExecutionIdentity,
	ToolExecutionRenderState,
	ToolExecutionResult,
	ToolRenderers,
} from "./tool-execution-types.ts";

export type { ToolRenderers } from "./tool-execution-types.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

/** Visual shell chosen by interactive chrome; classic remains the default. */
export type ToolExecutionPresentation = "classic" | "grok";

export class ToolExecutionComponent extends Container {
	private readonly identity: ToolExecutionIdentity;
	private readonly ui: TUI;
	private readonly renderer: ToolExecutionRenderer | undefined;
	private readonly images: ToolExecutionImages | undefined;
	private readonly grokRow: GrokToolRow | undefined;
	private readonly presentation: ToolExecutionPresentation;
	private args: unknown;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private executionStarted = false;
	private argsComplete = false;
	private result?: ToolExecutionResult;
	private lastDisplaySignature?: string;
	private readonly renderCache = new ToolExecutionRenderCache();
	private readonly animation = new ToolExecutionAnimation({
		invalidate: () => this.invalidateRenderCache(),
		redraw: () => {
			this.updateDisplay();
			this.ui.requestRender();
		},
	});

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | undefined,
		ui: TUI,
		cwd: string,
		presentation: ToolExecutionPresentation = "classic",
	) {
		super();
		this.identity = { toolName, toolCallId, cwd, toolDefinition };
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.presentation = presentation;
		const initialState = this.createRenderState();
		if (this.presentation === "grok") {
			this.grokRow = new GrokToolRow({
				toolName: this.identity.toolName,
				isPartial: initialState.isPartial,
				result: initialState.result,
			});
			this.addChild(new Spacer(1));
			this.addChild(this.grokRow);
		} else {
			this.renderer = new ToolExecutionRenderer(
				this.identity,
				initialState,
				() => {
					this.invalidate();
					this.ui.requestRender();
				},
				// Left-clicking a finished tool card toggles it like the expand keybinding does.
				() => {
					this.setExpanded(!this.expanded);
					this.ui.requestRender();
				},
			);
			this.images = new ToolExecutionImages(() => {
				this.invalidateRenderCache();
				this.ui.requestRender();
			});
			this.addChild(new Spacer(1));
			this.addChild(this.renderer);
			this.addChild(this.images);
		}
		this.updateSpinnerAnimation();
		this.updateDisplay();
	}

	updateArgs(args: unknown): void {
		this.args = args;
		this.lastDisplaySignature = undefined;
		this.updateSpinnerAnimation();
		this.updateDisplay();
	}

	/** Read-only presentation state; execution routing continues to own this original card. */
	get presentationSnapshot() {
		return { identity: this.identity, state: this.createRenderState(), presentation: this.presentation };
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateSpinnerAnimation();
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateSpinnerAnimation();
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: ToolExecutionResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		// senpi#1960: a finished card's retained result is measured once at finalize; a streaming card keeps its last figure.
		if (!isPartial) {
			this.argsComplete = true;
			this.renderCache.finalizeResult(serializedToolResultBytes(result));
		}
		this.lastDisplaySignature = undefined;
		this.updateSpinnerAnimation();
		this.updateTodoStrikeAnimation();
		this.updateDisplay();
		this.images?.updateResult(result);
		this.renderCache.setImages(result.content.filter((part) => part.type === "image").length);
		this.invalidateRenderCache();
	}

	stopAnimation(): void {
		this.animation.stop();
	}

	override dispose(): void {
		this.stopAnimation();
		this.renderCache.dispose();
		super.dispose();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		this.invalidateRenderCache();
		super.invalidate();
		this.lastDisplaySignature = undefined;
		this.updateDisplay();
	}

	/**
	 * A finished card renders from state that only changes through this class's setters, each of which
	 * moves the revision. Cards still streaming arguments, running, animating, or in the grok
	 * presentation keep rendering every frame because their output can change between setter calls.
	 */
	override getRenderRevision(): number | undefined {
		if (
			this.presentation === "grok" ||
			this.isPartial ||
			!this.argsComplete ||
			this.result === undefined ||
			this.animation.running
		) {
			return undefined;
		}
		return this.renderCache.revision;
	}

	override render(width: number): string[] {
		if (this.presentation === "grok") return super.render(width);

		const signature = this.createRenderSignature();
		const cached = this.renderCache.read(width, signature);
		if (cached) return cached;

		let lines: string[];
		const renderer = this.renderer!;
		const images = this.images!;
		if (renderer.hasRendererDefinition && renderer.renderShell === "self") {
			const contentLines = renderer.render(width);
			const imageLines = images.render(width);
			if (contentLines.length === 0 && imageLines.length === 0) return [];
			lines = contentLines.length > 0 ? ["", ...contentLines, ...imageLines] : imageLines;
		} else {
			lines = super.render(width);
		}

		this.renderCache.store(width, signature, lines);
		return lines;
	}

	private updateDisplay(): void {
		const displaySignature = this.createRenderSignature();
		if (this.lastDisplaySignature === displaySignature) return;
		this.lastDisplaySignature = displaySignature;
		this.invalidateRenderCache();
		const state = this.createRenderState();
		if (this.grokRow) {
			this.grokRow.update({
				toolName: this.identity.toolName,
				isPartial: state.isPartial,
				result: state.result,
			});
			return;
		}
		const renderer = this.renderer!;
		const renderState =
			renderer.hasRendererDefinition && !renderer.hasResultRenderer
				? { ...state, result: collapseFallbackResult(state.result, state.showImages, state.expanded) }
				: state;
		renderer.update(renderState);
		this.images!.updateOptions({
			showImages: state.showImages,
			maxWidthCells: this.imageWidthCells,
			showRendererFallback: renderer.hasResultRenderer,
		});
	}

	private createRenderState(): ToolExecutionRenderState {
		return {
			args: this.args,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			spinnerFrame: this.animation.frame,
			result: this.result
				? { ...this.result, content: this.result.content.filter((part) => !isModelOnlyText(part)) }
				: undefined,
		};
	}

	private createRenderSignature(): string {
		return createBoundedRenderSignature({
			...this.createRenderState(),
			imageWidthCells: this.imageWidthCells,
			toolCallId: this.identity.toolCallId,
			toolName: this.identity.toolName,
		});
	}

	private updateSpinnerAnimation(): void {
		this.animation.spin(toolCardSpins(this.identity.toolName, this.createRenderState()));
	}

	private updateTodoStrikeAnimation(): void {
		this.animation.strike(toolCardStrikes(this.identity.toolName, this.createRenderState()));
	}

	private invalidateRenderCache(): void {
		this.renderCache.invalidate();
	}
}
