import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { ToolDef } from "../../../core/tools/index.ts";
import { GrokToolRow } from "../grok/tool-row.ts";
import { readToolProgress } from "../tool-progress.ts";
import { hasCompletedTodoTasks, TODO_STRIKE_FRAME_INTERVAL_MS, TODO_STRIKE_TOTAL_FRAMES } from "./todo-strike.ts";
import { ToolExecutionController, type ToolExecutionPresentation } from "./tool-execution-controller.ts";
import { ToolExecutionImages } from "./tool-execution-images.ts";
import { ToolExecutionRenderer } from "./tool-execution-renderer.ts";
import type {
	ToolExecutionIdentity,
	ToolExecutionRenderState,
	ToolExecutionResult,
	ToolOutputMode,
} from "./tool-execution-types.ts";

export type { ToolExecutionPresentation } from "./tool-execution-controller.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputMode?: ToolOutputMode;
	trustedBuiltIn?: boolean;
}

const PENDING_RENDER_FRAME_INTERVAL_MS = 80;

export class ToolExecutionComponent extends Container {
	private readonly identity: ToolExecutionIdentity;
	private readonly ui: TUI;
	private readonly renderer: ToolExecutionRenderer | undefined;
	private readonly images: ToolExecutionImages | undefined;
	private readonly grokRow: GrokToolRow | undefined;
	private readonly controller: ToolExecutionController;
	private args: unknown;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private executionStarted = false;
	private argsComplete = false;
	private spinnerFrame?: number;
	private spinnerInterval?: NodeJS.Timeout;
	private todoStrikeInterval?: NodeJS.Timeout;
	private result?: ToolExecutionResult;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDef | undefined,
		ui: TUI,
		cwd: string,
		presentation: ToolExecutionPresentation = "classic",
	) {
		super();
		this.identity = {
			toolName,
			toolCallId,
			cwd,
			toolDefinition,
			trustedBuiltIn: options.trustedBuiltIn ?? false,
		};
		this.args = args;
		const outputMode = options.outputMode ?? "collapsed";
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		const initialState = this.createRenderState(outputMode === "expanded");
		this.controller = new ToolExecutionController(this.identity, initialState, outputMode, presentation);
		if (presentation === "grok") {
			this.grokRow = new GrokToolRow({
				toolName: this.identity.toolName,
				isPartial: initialState.isPartial,
				result: initialState.result,
			});
			this.addChild(new Spacer(1));
			this.addChild(this.grokRow);
		} else {
			this.renderer = new ToolExecutionRenderer(this.identity, initialState, () => {
				this.invalidate();
				this.ui.requestRender();
			});
			this.images = new ToolExecutionImages(() => {
				this.controller.invalidateRenderCache();
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
		this.controller.invalidateDisplay();
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
		this.controller.invalidateDisplay();
		this.updateSpinnerAnimation();
		this.updateTodoStrikeAnimation();
		this.updateDisplay();
		if (!this.controller.isAtomic) this.images?.updateResult(result);
		this.controller.invalidateRenderCache();
	}

	stopAnimation(): void {
		this.stopSpinnerAnimation();
		this.stopTodoStrikeAnimation();
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}

	setExpanded(expanded: boolean): void {
		this.setOutputMode(expanded ? "expanded" : "collapsed");
	}

	setOutputMode(outputMode: ToolOutputMode): void {
		const transition = this.controller.setOutputMode(outputMode);
		if (!transition.changed) return;
		if (transition.leftAtomic && this.result) this.images?.updateResult(this.result);
		this.updateSpinnerAnimation();
		this.updateDisplay();
		this.ui.requestRender();
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
		this.controller.invalidateDisplay();
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		return this.controller.render(width, this.createRenderState(), this.imageWidthCells, {
			renderer: this.renderer,
			images: this.images,
			grokRow: this.grokRow,
			renderContainer: (containerWidth) => super.render(containerWidth),
		});
	}

	private updateDisplay(): void {
		this.controller.updateDisplay(this.createRenderState(), this.imageWidthCells, {
			renderer: this.renderer,
			images: this.images,
			grokRow: this.grokRow,
			renderContainer: (width) => super.render(width),
		});
	}

	private createRenderState(expanded = this.controller.expanded): ToolExecutionRenderState {
		return {
			args: this.args,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded,
			showImages: this.showImages,
			spinnerFrame: this.spinnerFrame,
			result: this.result,
		};
	}

	private updateSpinnerAnimation(): void {
		const atomicPolicy = this.controller.atomicSpinnerPolicy(this.createRenderState());
		if (atomicPolicy !== undefined) {
			if (atomicPolicy) this.startSpinnerAnimation();
			else this.stopSpinnerAnimation();
			return;
		}

		const isStreamingArgs = !this.argsComplete && ["edit", "write", "apply_patch"].includes(this.identity.toolName);
		const isPartialTask = this.isPartial && this.identity.toolName === "task" && this.result !== undefined;
		const isPartialProgress =
			this.isPartial && this.result !== undefined && readToolProgress(this.result.details) !== undefined;
		if (isStreamingArgs || isPartialTask || isPartialProgress) this.startSpinnerAnimation();
		else this.stopSpinnerAnimation();
	}

	private updateTodoStrikeAnimation(): void {
		const shouldAnimate =
			this.identity.trustedBuiltIn &&
			this.identity.toolName === "todo" &&
			this.executionStarted &&
			!this.isPartial &&
			this.result !== undefined &&
			!this.result.isError &&
			hasCompletedTodoTasks(this.result.details);
		if (!shouldAnimate) {
			this.stopTodoStrikeAnimation();
			return;
		}
		if (this.todoStrikeInterval) return;

		this.spinnerFrame = 0;
		this.todoStrikeInterval = setInterval(() => {
			const next = (this.spinnerFrame ?? 0) + 1;
			if (next > TODO_STRIKE_TOTAL_FRAMES) {
				this.stopTodoStrikeAnimation();
				return;
			}
			this.spinnerFrame = next;
			this.controller.invalidateRenderCache();
			this.updateDisplay();
			this.ui.requestRender();
		}, TODO_STRIKE_FRAME_INTERVAL_MS);
		this.todoStrikeInterval.unref?.();
	}

	private stopTodoStrikeAnimation(): void {
		if (this.todoStrikeInterval) {
			clearInterval(this.todoStrikeInterval);
			this.todoStrikeInterval = undefined;
		}
		if (!this.spinnerInterval && this.spinnerFrame !== undefined) {
			this.spinnerFrame = undefined;
			this.controller.invalidateRenderCache();
			this.updateDisplay();
			this.ui.requestRender();
		}
	}

	private startSpinnerAnimation(): void {
		if (this.spinnerInterval) return;
		this.spinnerInterval = setInterval(() => {
			this.spinnerFrame = ((this.spinnerFrame ?? -1) + 1) % 10;
			this.controller.invalidateRenderCache();
			this.updateDisplay();
			this.ui.requestRender();
		}, PENDING_RENDER_FRAME_INTERVAL_MS);
		this.spinnerInterval.unref?.();
	}

	private stopSpinnerAnimation(): void {
		if (!this.spinnerInterval) return;
		clearInterval(this.spinnerInterval);
		this.spinnerInterval = undefined;
		if (!this.todoStrikeInterval) this.spinnerFrame = undefined;
		this.controller.invalidateRenderCache();
	}
}
