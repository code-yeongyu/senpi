import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { ToolDef } from "../../../core/tools/index.ts";
import { readToolProgress } from "../tool-progress.ts";
import { createBoundedRenderSignature } from "./render-signature.ts";
import { ToolExecutionImages } from "./tool-execution-images.ts";
import { ToolExecutionRenderer } from "./tool-execution-renderer.ts";
import type { ToolExecutionIdentity, ToolExecutionRenderState, ToolExecutionResult } from "./tool-execution-types.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

const PENDING_RENDER_FRAME_INTERVAL_MS = 80;

export class ToolExecutionComponent extends Container {
	private readonly identity: ToolExecutionIdentity;
	private readonly ui: TUI;
	private readonly renderer: ToolExecutionRenderer;
	private readonly images: ToolExecutionImages;
	private args: unknown;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private executionStarted = false;
	private argsComplete = false;
	private spinnerFrame?: number;
	private spinnerInterval?: NodeJS.Timeout;
	private result?: ToolExecutionResult;
	private cachedLines?: string[];
	private cachedSignature?: string;
	private cachedWidth?: number;
	private lastDisplaySignature?: string;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDef | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.identity = { toolName, toolCallId, cwd, toolDefinition };
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		const initialState = this.createRenderState();
		this.renderer = new ToolExecutionRenderer(this.identity, initialState, () => {
			this.invalidate();
			this.ui.requestRender();
		});
		this.images = new ToolExecutionImages(() => {
			this.invalidateRenderCache();
			this.ui.requestRender();
		});
		this.addChild(new Spacer(1));
		this.addChild(this.renderer);
		this.addChild(this.images);
		this.updateSpinnerAnimation();
		this.updateDisplay();
	}

	updateArgs(args: unknown): void {
		this.args = args;
		this.lastDisplaySignature = undefined;
		this.updateSpinnerAnimation();
		this.updateDisplay();
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
		if (!isPartial) this.argsComplete = true;
		this.lastDisplaySignature = undefined;
		this.updateSpinnerAnimation();
		this.updateDisplay();
		this.images.updateResult(result);
		this.invalidateRenderCache();
	}

	stopAnimation(): void {
		this.stopSpinnerAnimation();
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

	override render(width: number): string[] {
		const signature = this.createRenderSignature();
		if (this.cachedLines && this.cachedWidth === width && this.cachedSignature === signature) {
			return [...this.cachedLines];
		}

		let lines: string[];
		if (this.renderer.hasRendererDefinition && this.renderer.renderShell === "self") {
			const contentLines = this.renderer.render(width);
			const imageLines = this.images.render(width);
			if (contentLines.length === 0 && imageLines.length === 0) return [];
			lines = contentLines.length > 0 ? ["", ...contentLines, ...imageLines] : imageLines;
		} else {
			lines = super.render(width);
		}

		this.cachedWidth = width;
		this.cachedSignature = signature;
		this.cachedLines = [...lines];
		return lines;
	}

	private updateDisplay(): void {
		const displaySignature = this.createRenderSignature();
		if (this.lastDisplaySignature === displaySignature) return;
		this.lastDisplaySignature = displaySignature;
		this.invalidateRenderCache();
		const state = this.createRenderState();
		this.renderer.update(state);
		this.images.updateOptions({
			showImages: state.showImages,
			maxWidthCells: this.imageWidthCells,
			showRendererFallback: this.renderer.hasResultRenderer,
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
			spinnerFrame: this.spinnerFrame,
			result: this.result,
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
		const isStreamingArgs = !this.argsComplete && ["edit", "write", "apply_patch"].includes(this.identity.toolName);
		const isPartialTask = this.isPartial && this.identity.toolName === "task" && this.result !== undefined;
		const isPartialProgress =
			this.isPartial && this.result !== undefined && readToolProgress(this.result.details) !== undefined;
		if (isStreamingArgs || isPartialTask || isPartialProgress) this.startSpinnerAnimation();
		else this.stopSpinnerAnimation();
	}

	private startSpinnerAnimation(): void {
		if (this.spinnerInterval) return;
		this.spinnerInterval = setInterval(() => {
			this.spinnerFrame = ((this.spinnerFrame ?? -1) + 1) % 10;
			this.invalidateRenderCache();
			this.updateDisplay();
			this.ui.requestRender();
		}, PENDING_RENDER_FRAME_INTERVAL_MS);
		this.spinnerInterval.unref?.();
	}

	private stopSpinnerAnimation(): void {
		if (!this.spinnerInterval) return;
		clearInterval(this.spinnerInterval);
		this.spinnerInterval = undefined;
		this.spinnerFrame = undefined;
		this.invalidateRenderCache();
	}

	private invalidateRenderCache(): void {
		this.cachedLines = undefined;
		this.cachedSignature = undefined;
		this.cachedWidth = undefined;
	}
}
